import { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AUDIO_CONFIG, createPcmBlob, decodeBase64, decodeAudioData } from '../utils/audioUtils';
import { Env } from '../utils/env';
import { ConnectionState, LogMessage } from '../types';

const SYSTEM_INSTRUCTION = `
Você é 'Sophie', uma tutora de francês charmosa, paciente e altamente qualificada. 
Seu objetivo é ajudar o usuário a praticar francês.

REGRAS DE OURO PARA TRADUÇÃO:
1. Para CADA frase que você falar em Francês, você deve fornecer a tradução em Português IMEDIATAMENTE em seguida.
2. O formato deve ser sempre: [Frase em Francês] ([Tradução em Português]).

Exemplos de interação:
Sophie: "Bonjour! Comment ça va aujourd'hui? (Olá! Como vai você hoje?)"
Usuário: "Ça va bien."
Sophie: "C'est très bien! Qu'as-tu fait de beau? (Isso é muito bom! O que você fez de bom?)"

Outras Regras:
- Se o usuário errar, explique gentilmente em Português.
- Mantenha a voz calma e encorajadora.
- Fale o Francês de forma clara para ajudar na compreensão.
`;

const STORAGE_KEY = 'fluent_french_chat_history';

export const useGeminiLive = () => {
    const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);

    // Initialize logs from localStorage (Restore Point)
    const [logs, setLogs] = useState<LogMessage[]>(() => {
        if (typeof window !== 'undefined') {
            try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    // Hydrate Date objects from strings
                    return parsed.map((item: any) => ({
                        ...item,
                        timestamp: new Date(item.timestamp)
                    }));
                }
            } catch (e) {
                console.warn('Failed to restore logs', e);
            }
        }
        return [];
    });

    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    const [volume, setVolume] = useState<number>(0);

    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const sessionRef = useRef<any>(null);
    const nextStartTimeRef = useRef<number>(0);
    const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    const streamRef = useRef<MediaStream | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);

    // Accumulators for transcription
    const currentInputRef = useRef<string>('');
    const currentOutputRef = useRef<string>('');

    // Persist logs to localStorage whenever they change
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
        } catch (e) {
            console.error('Failed to save logs persistence', e);
        }
    }, [logs]);

    const addLog = (text: string, role: 'user' | 'model' | 'system') => {
        setLogs(prev => {
            // Keep last 50 messages to prevent storage bloat
            const newLogs = [...prev, { role, text, timestamp: new Date() }].slice(-50);
            return newLogs;
        });
    };

    const clearLogs = useCallback(() => {
        setLogs([]);
        localStorage.removeItem(STORAGE_KEY);
    }, []);

    // Simple downsampler for 48k/44.1k -> 16k if needed
    const downsampleBuffer = (buffer: Float32Array, inputRate: number, outputRate: number) => {
        if (inputRate === outputRate) return buffer;
        if (inputRate < outputRate) return buffer;

        const ratio = inputRate / outputRate;
        const newLength = Math.ceil(buffer.length / ratio);
        const result = new Float32Array(newLength);

        for (let i = 0; i < newLength; i++) {
            const offset = Math.floor(i * ratio);
            // Basic nearest neighbor to avoid complex filtering overhead in JS main thread
            if (offset < buffer.length) {
                result[i] = buffer[offset];
            }
        }
        return result;
    };

    const requestWakeLock = async () => {
        try {
            if ('wakeLock' in navigator) {
                // If already locked and not released, do nothing
                if (wakeLockRef.current && !wakeLockRef.current.released) {
                    return;
                }

                const lock = await navigator.wakeLock.request('screen');
                lock.addEventListener('release', () => {
                    console.log('Wake Lock released');
                });
                wakeLockRef.current = lock;
                console.log('Wake Lock acquired');
            }
        } catch (err) {
            console.warn('Wake Lock denied or failed', err);
        }
    };

    const releaseWakeLock = async () => {
        try {
            if (wakeLockRef.current) {
                await wakeLockRef.current.release();
                wakeLockRef.current = null;
            }
        } catch (err) {
            console.warn('Wake Lock release error', err);
        }
    };

    // Re-acquire WakeLock and Resume Audio on Visibility Change (Mobile App Switch)
    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (document.visibilityState === 'visible') {
                console.log('App visible, checking resources...');

                // 1. Re-acquire Wake Lock if we are connected
                if (connectionState === ConnectionState.CONNECTED) {
                    await requestWakeLock();
                }

                // 2. Resume Audio Contexts (Mobile browsers suspend them in background)
                if (inputAudioContextRef.current?.state === 'suspended') {
                    console.log('Resuming input context');
                    await inputAudioContextRef.current.resume();
                }
                if (outputAudioContextRef.current?.state === 'suspended') {
                    console.log('Resuming output context');
                    await outputAudioContextRef.current.resume();
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [connectionState]);

    const connect = async () => {
        if (!Env.GEMINI_API_KEY) {
            addLog("API Key missing.", 'system');
            return;
        }

        try {
            setConnectionState(ConnectionState.CONNECTING);
            addLog("Iniciando sessão...", 'system');

            // Initialize Audio Contexts
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const inputCtx = new AudioContextClass({ sampleRate: AUDIO_CONFIG.inputSampleRate });
            const outputCtx = new AudioContextClass({ sampleRate: AUDIO_CONFIG.outputSampleRate });

            // Resume immediately (fix for mobile auto-play policies)
            if (inputCtx.state === 'suspended') await inputCtx.resume();
            if (outputCtx.state === 'suspended') await outputCtx.resume();

            inputAudioContextRef.current = inputCtx;
            outputAudioContextRef.current = outputCtx;

            // Setup Analyser
            const analyzerNode = outputCtx.createAnalyser();
            analyzerNode.fftSize = 256;
            analyzerNode.smoothingTimeConstant = 0.5;
            analyzerNode.connect(outputCtx.destination);
            setAnalyser(analyzerNode);

            // Request Wake Lock for mobile
            await requestWakeLock();

            const ai = new GoogleGenAI({ apiKey: Env.GEMINI_API_KEY });

            // Connect to Live API
            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                    },
                    systemInstruction: SYSTEM_INSTRUCTION,
                    // Enable transcription for both input (user) and output (model)
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
                callbacks: {
                    onopen: async () => {
                        addLog("Conectado! Fale agora.", 'system');
                        setConnectionState(ConnectionState.CONNECTED);

                        // Start Microphone Input with mobile-optimized constraints
                        try {
                            const stream = await navigator.mediaDevices.getUserMedia({
                                audio: {
                                    echoCancellation: true,
                                    noiseSuppression: true,
                                    autoGainControl: true,
                                    sampleRate: AUDIO_CONFIG.inputSampleRate
                                }
                            });
                            streamRef.current = stream;

                            const source = inputCtx.createMediaStreamSource(stream);
                            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
                            scriptProcessorRef.current = processor;

                            processor.onaudioprocess = (e) => {
                                const inputData = e.inputBuffer.getChannelData(0);

                                // Calculate volume for visualizer
                                let sum = 0;
                                // Optimize loop for volume calc
                                for (let i = 0; i < inputData.length; i += 4) sum += inputData[i] * inputData[i];
                                setVolume(Math.sqrt(sum / (inputData.length / 4)));

                                // Handle sample rate mismatch (Mobile Fallback)
                                let processData = inputData;
                                if (inputCtx.sampleRate !== AUDIO_CONFIG.inputSampleRate) {
                                    processData = downsampleBuffer(inputData, inputCtx.sampleRate, AUDIO_CONFIG.inputSampleRate);
                                }

                                const pcmBlob = createPcmBlob(processData);
                                sessionPromise.then(session => {
                                    session.sendRealtimeInput({ media: pcmBlob });
                                });
                            };

                            source.connect(processor);
                            processor.connect(inputCtx.destination);
                        } catch (err) {
                            console.error("Mic error", err);
                            addLog("Erro ao acessar microfone. Verifique permissões.", 'system');
                            disconnect();
                        }
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        // Handle Audio Output
                        const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                        if (base64Audio && outputAudioContextRef.current) {
                            const ctx = outputAudioContextRef.current;
                            // Ensure context is running on receiving message (mobile safeguard)
                            if (ctx.state === 'suspended') await ctx.resume();

                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

                            const audioBuffer = await decodeAudioData(
                                decodeBase64(base64Audio),
                                ctx,
                                AUDIO_CONFIG.outputSampleRate
                            );

                            const source = ctx.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(analyzerNode);

                            source.addEventListener('ended', () => {
                                sourcesRef.current.delete(source);
                            });

                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sourcesRef.current.add(source);
                        }

                        // Handle Transcriptions
                        const inputTx = message.serverContent?.inputTranscription?.text;
                        if (inputTx) {
                            currentInputRef.current += inputTx;
                        }

                        const outputTx = message.serverContent?.outputTranscription?.text;
                        if (outputTx) {
                            currentOutputRef.current += outputTx;
                        }

                        // Handle Turn Complete (Commit text to logs)
                        if (message.serverContent?.turnComplete) {
                            if (currentInputRef.current.trim()) {
                                addLog(currentInputRef.current.trim(), 'user');
                                currentInputRef.current = '';
                            }
                            if (currentOutputRef.current.trim()) {
                                addLog(currentOutputRef.current.trim(), 'model');
                                currentOutputRef.current = '';
                            }
                        }

                        // Handle Interruption
                        if (message.serverContent?.interrupted) {
                            addLog("Interrupção.", 'system');
                            sourcesRef.current.forEach(src => {
                                try { src.stop(); } catch (e) { }
                            });
                            sourcesRef.current.clear();
                            nextStartTimeRef.current = 0;
                            // Reset transcription buffers on interrupt
                            currentOutputRef.current = '';
                        }
                    },
                    onclose: () => {
                        addLog("Conexão fechada.", 'system');
                        setConnectionState(ConnectionState.DISCONNECTED);
                        releaseWakeLock();
                    },
                    onerror: (e) => {
                        console.error("Session error", e);
                        addLog("Erro na sessão.", 'system');
                        setConnectionState(ConnectionState.ERROR);
                        releaseWakeLock();
                    }
                }
            });

            sessionRef.current = sessionPromise;

        } catch (error) {
            console.error(error);
            setConnectionState(ConnectionState.ERROR);
            addLog("Falha ao iniciar. Tente recarregar.", 'system');
            releaseWakeLock();
        }
    };

    const disconnect = useCallback(() => {
        if (sessionRef.current) {
            sessionRef.current.then((s: any) => s.close());
            sessionRef.current = null;
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }

        if (inputAudioContextRef.current) {
            inputAudioContextRef.current.close();
            inputAudioContextRef.current = null;
        }
        if (outputAudioContextRef.current) {
            outputAudioContextRef.current.close();
            outputAudioContextRef.current = null;
        }

        releaseWakeLock();

        setConnectionState(ConnectionState.DISCONNECTED);
        setAnalyser(null);
        // Clear transcription buffers
        currentInputRef.current = '';
        currentOutputRef.current = '';
    }, []);

    useEffect(() => {
        return () => disconnect();
    }, [disconnect]);

    return {
        connect,
        disconnect,
        clearLogs,
        connectionState,
        logs,
        analyser,
        volume
    };
};