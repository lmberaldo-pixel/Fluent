import { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AUDIO_CONFIG, createPcmBlob, decodeBase64, decodeAudioData } from '../utils/audioUtils';
import { ConnectionState, LogMessage } from '../types';

const SYSTEM_INSTRUCTION = `
Você é 'Sophie', uma tutora de francês charmosa, paciente e altamente qualificada. 
Seu objetivo é ajudar o usuário a praticar francês.

REGRAS DE OURO PARA TRADUÇÃO:
1. Para CADA frase que você falar em Francês, você deve fornecer a tradução em Português IMEDIATAMENTE em seguida.
2. O formato deve ser sempre: [Frase em Francês] ([Tradução em Português]).

Sophie: "Bonjour! Comment ça va aujourd'hui? (Olá! Como vai você hoje?)"
`;

const STORAGE_KEY = 'fluent_french_chat_history';

export const useGeminiLive = () => {
    const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
    const isConnectedRef = useRef(false);

    const [logs, setLogs] = useState<LogMessage[]>(() => {
        if (typeof window !== 'undefined') {
            try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved) {
                    const parsed = JSON.parse(saved);
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

    const currentInputRef = useRef<string>('');
    const currentOutputRef = useRef<string>('');

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
        } catch (e) {
            console.error('Failed to save logs', e);
        }
    }, [logs]);

    const addLog = (text: string, role: 'user' | 'model' | 'system') => {
        setLogs(prev => {
            const newLogs = [...prev, { role, text, timestamp: new Date() }].slice(-50);
            return newLogs;
        });
    };

    const clearLogs = useCallback(() => {
        setLogs([]);
        localStorage.removeItem(STORAGE_KEY);
    }, []);

    const downsampleBuffer = (buffer: Float32Array, inputRate: number, outputRate: number) => {
        if (inputRate === outputRate) return buffer;
        const ratio = inputRate / outputRate;
        const newLength = Math.ceil(buffer.length / ratio);
        const result = new Float32Array(newLength);
        for (let i = 0; i < newLength; i++) {
            const offset = Math.floor(i * ratio);
            if (offset < buffer.length) result[i] = buffer[offset];
        }
        return result;
    };

    const requestWakeLock = async () => {
        try {
            if ('wakeLock' in navigator) {
                if (wakeLockRef.current && !wakeLockRef.current.released) return;
                const lock = await navigator.wakeLock.request('screen');
                wakeLockRef.current = lock;
            }
        } catch (err) {
            console.warn('Wake Lock failed', err);
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

    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (document.visibilityState === 'visible') {
                if (isConnectedRef.current) await requestWakeLock();
                if (inputAudioContextRef.current?.state === 'suspended') await inputAudioContextRef.current.resume();
                if (outputAudioContextRef.current?.state === 'suspended') await outputAudioContextRef.current.resume();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, []);

    const connect = async () => {
        const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.API_KEY;
        console.log("[useGeminiLive] Connect triggered. API_KEY present:", !!apiKey);

        if (!apiKey) {
            console.error("[useGeminiLive] MISSING API KEY. Tried import.meta.env.VITE_GEMINI_API_KEY and process.env.API_KEY");
            addLog("Chave da API não configurada.", 'system');
            return;
        }

        if (connectionState === ConnectionState.CONNECTING || isConnectedRef.current) return;

        try {
            setConnectionState(ConnectionState.CONNECTING);
            addLog("Iniciando sessão...", 'system');

            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const inputCtx = new AudioContextClass({ sampleRate: AUDIO_CONFIG.inputSampleRate });
            const outputCtx = new AudioContextClass({ sampleRate: AUDIO_CONFIG.outputSampleRate });

            if (inputCtx.state === 'suspended') await inputCtx.resume();
            if (outputCtx.state === 'suspended') await outputCtx.resume();

            inputAudioContextRef.current = inputCtx;
            outputAudioContextRef.current = outputCtx;

            const analyzerNode = outputCtx.createAnalyser();
            analyzerNode.fftSize = 256;
            analyzerNode.connect(outputCtx.destination);
            setAnalyser(analyzerNode);

            const ai = new GoogleGenAI({ apiKey });

            console.log("[useGeminiLive] Reverting to last known working state (exp model)...");

            const session = await ai.live.connect({
                model: 'gemini-2.0-flash-exp',
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
                    },
                    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
                },
                callbacks: {
                    onopen: async () => {
                        console.log("[useGeminiLive] SESSION READY. Waiting handshake delay...");

                        // Small delay to ensure session is fully ready before we start streaming mic data
                        await new Promise(resolve => setTimeout(resolve, 500));

                        addLog("Conectado!", 'system');
                        setConnectionState(ConnectionState.CONNECTED);
                        isConnectedRef.current = true;
                        await requestWakeLock();

                        try {
                            const stream = await navigator.mediaDevices.getUserMedia({
                                audio: { echoCancellation: true, noiseSuppression: true, sampleRate: AUDIO_CONFIG.inputSampleRate }
                            });
                            streamRef.current = stream;

                            const source = inputCtx.createMediaStreamSource(stream);
                            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
                            scriptProcessorRef.current = processor;

                            processor.onaudioprocess = (e) => {
                                if (!isConnectedRef.current) return;
                                const inputData = e.inputBuffer.getChannelData(0);
                                let sum = 0;
                                for (let i = 0; i < inputData.length; i += 4) sum += inputData[i] * inputData[i];
                                setVolume(Math.sqrt(sum / (inputData.length / 4)));

                                let processData = inputData;
                                if (inputCtx.sampleRate !== AUDIO_CONFIG.inputSampleRate) {
                                    processData = downsampleBuffer(inputData, inputCtx.sampleRate, AUDIO_CONFIG.inputSampleRate);
                                }

                                try {
                                    session.sendRealtimeInput({ media: createPcmBlob(processData) });
                                } catch (err) {
                                    console.warn("[useGeminiLive] Handshake probably not finished", err);
                                }
                            };

                            source.connect(processor);
                            processor.connect(inputCtx.destination);
                        } catch (err) {
                            console.error("[useGeminiLive] Mic Error:", err);
                            addLog("Erro de microfone.", 'system');
                            disconnect();
                        }
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                        if (base64Audio && outputAudioContextRef.current) {
                            const ctx = outputAudioContextRef.current;
                            if (ctx.state === 'suspended') await ctx.resume();
                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                            const audioBuffer = await decodeAudioData(decodeBase64(base64Audio), ctx, AUDIO_CONFIG.outputSampleRate);
                            const source = ctx.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(analyzerNode);
                            source.addEventListener('ended', () => sourcesRef.current.delete(source));
                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sourcesRef.current.add(source);
                        }

                        if (message.serverContent?.inputTranscription?.text) currentInputRef.current += message.serverContent.inputTranscription.text;
                        if (message.serverContent?.outputTranscription?.text) currentOutputRef.current += message.serverContent.outputTranscription.text;

                        if (message.serverContent?.turnComplete) {
                            if (currentInputRef.current.trim()) { addLog(currentInputRef.current.trim(), 'user'); currentInputRef.current = ''; }
                            if (currentOutputRef.current.trim()) { addLog(currentOutputRef.current.trim(), 'model'); currentOutputRef.current = ''; }
                        }

                        if (message.serverContent?.interrupted) {
                            sourcesRef.current.forEach(src => { try { src.stop(); } catch (e) { } });
                            sourcesRef.current.clear();
                            nextStartTimeRef.current = 0;
                            currentOutputRef.current = '';
                        }
                    },
                    onclose: (event) => {
                        console.log("[useGeminiLive] SESSION CLOSED:", event);
                        if (isConnectedRef.current) {
                            const msg = `Sessão encerrada pelo servidor.\nCódigo: ${event?.code || 'N/A'}\nMotivo: ${event?.reason || 'Sem motivo informado'}`;
                            alert(msg);
                        }
                        addLog("Conexão interrompida.", 'system');
                        setConnectionState(ConnectionState.DISCONNECTED);
                        isConnectedRef.current = false;
                        releaseWakeLock();
                    },
                    onerror: (e) => {
                        console.error("[useGeminiLive] SESSION ERROR:", e);
                        setConnectionState(ConnectionState.ERROR);
                        isConnectedRef.current = false;
                        releaseWakeLock();
                    }
                }
            });

            sessionRef.current = session;

        } catch (error) {
            console.error("[useGeminiLive] CONNECTION FAILED:", error);
            setConnectionState(ConnectionState.ERROR);
            addLog("Erro ao conectar.", 'system');
            releaseWakeLock();
        }
    };

    const disconnect = useCallback(() => {
        console.log("[useGeminiLive] MANUAL DISCONNECT");
        isConnectedRef.current = false;
        if (sessionRef.current) { try { sessionRef.current.close(); } catch (e) { } sessionRef.current = null; }
        if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
        if (scriptProcessorRef.current) { scriptProcessorRef.current.disconnect(); scriptProcessorRef.current = null; }
        if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
        if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
        releaseWakeLock();
        setConnectionState(ConnectionState.DISCONNECTED);
        setAnalyser(null);
    }, []);

    useEffect(() => { return () => disconnect(); }, [disconnect]);

    return { connect, disconnect, clearLogs, connectionState, logs, analyser, volume };
};