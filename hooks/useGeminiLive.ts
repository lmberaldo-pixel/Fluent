import { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AUDIO_CONFIG, createPcmBlob, decodeBase64, decodeAudioData } from '../utils/audioUtils';
import { ConnectionState, LogMessage } from '../types';
import { supabase } from '../utils/supabaseClient';

const SYSTEM_INSTRUCTION = `
Você é 'Sophie', uma tutora de francês charmosa, paciente e altamente qualificada. 
Seu objetivo é ajudar o usuário a praticar francês.

REGRAS DE OURO PARA TRADUÇÃO:
1. Para CADA frase que você falar em Francês, você deve fornecer a tradução em Português IMEDIATAMENTE em seguida.
2. O formato deve ser sempre: [Frase em Francês] ([Tradução em Português]).

Sophie: "Bonjour! Comment ça va hoje? (Olá! Como vai você hoje?)"
`;

const STORAGE_KEY = 'fluent_french_chat_history';

export const useGeminiLive = () => {
    const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
    const isConnectedRef = useRef(false);
    const sessionIdRef = useRef<number>(0);

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

    const audioContextRef = useRef<AudioContext | null>(null);
    const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const sessionRef = useRef<any>(null);
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);

    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    const [volume, setVolume] = useState<number>(0);

    const nextStartTimeRef = useRef<number>(0);
    const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

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
                if (audioContextRef.current?.state === 'suspended') await audioContextRef.current.resume();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, []);

    const disconnect = useCallback((reason: any = "unknown") => {
        const reasonStr = typeof reason === 'string' ? reason : (reason?.type || "object");
        console.log(`[useGeminiLive] DISCONNECTING... Reason: ${reasonStr}`);
        isConnectedRef.current = false;
        sessionIdRef.current = 0; // Invalidate current session

        if (sessionRef.current) { try { sessionRef.current.close(); } catch (e) { } sessionRef.current = null; }
        if (streamRef.current) { try { streamRef.current.getTracks().forEach(track => track.stop()); } catch (e) { } streamRef.current = null; }

        if (audioSourceRef.current) { try { audioSourceRef.current.disconnect(); } catch (e) { } audioSourceRef.current = null; }
        if (processorNodeRef.current) { try { processorNodeRef.current.disconnect(); } catch (e) { } processorNodeRef.current = null; }
        if (analyserRef.current) { try { analyserRef.current.disconnect(); } catch (e) { } analyserRef.current = null; }
        if (audioContextRef.current) { try { audioContextRef.current.close(); } catch (e) { } audioContextRef.current = null; }

        releaseWakeLock();
        setConnectionState(ConnectionState.DISCONNECTED);
        setAnalyser(null);
        setVolume(0);
    }, []);

    const connect = async () => {
        // Strict Atomic Guard: Don't allow multiple connection attempts
        if (connectionState !== ConnectionState.DISCONNECTED || isConnectedRef.current) {
            console.warn("[useGeminiLive] Already connecting or connected. Ignoring request.");
            return;
        }

        setConnectionState(ConnectionState.CONNECTING);
        addLog("Obtendo permissão de acesso...", 'system');

        let apiKey = '';
        try {
            if (!supabase) throw new Error("Supabase não configurado. Verifique as variáveis de ambiente VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no GitHub.");

            const { data, error } = await supabase
                .from('secrets')
                .select('value')
                .eq('name', 'GEMINI_API_KEY')
                .single();

            if (error || !data) throw error || new Error("Chave não encontrada no banco");
            apiKey = data.value;
        } catch (err: any) {
            console.error("Erro ao buscar a chave no Supabase:", err);
            addLog(`Erro: ${err.message || 'Falha ao autenticar a IA.'}`, 'system');
            setConnectionState(ConnectionState.DISCONNECTED);
            return;
        }

        if (!apiKey) {
            addLog("Chave da API não configurada corretamente no sistema.", 'system');
            setConnectionState(ConnectionState.DISCONNECTED);
            return;
        }

        // Strict Atomic Guard: Don't allow multiple connection attempts
        if (connectionState !== ConnectionState.DISCONNECTED || isConnectedRef.current) {
            console.warn("[useGeminiLive] Already connecting or connected. Ignoring request.");
            return;
        }

        const currentSessionId = Date.now();
        sessionIdRef.current = currentSessionId;

        try {
            addLog("Conectando...", 'system');
            console.log("[useGeminiLive] Using API Key:", apiKey.substring(0, 5) + "...");
            console.log("[useGeminiLive] Connecting with model: gemini-2.5-flash-native-audio-preview-12-2025");

            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AudioContextClass();
            audioContextRef.current = ctx;

            if (ctx.state === 'suspended') await ctx.resume();
            console.log("[useGeminiLive] AudioContext active at:", ctx.sampleRate, "Hz");

            const analyserNode = ctx.createAnalyser();
            analyserNode.fftSize = 256;
            // Removed: analyserNode.connect(ctx.destination); // Stopping mic echo
            analyserRef.current = analyserNode;
            setAnalyser(analyserNode);

            console.log("[useGeminiLive] Instantiating GoogleGenAI with key length:", apiKey?.length);
            const ai = new GoogleGenAI({ apiKey });

            const session = await ai.live.connect({
                model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } // 'Aoede' is a clear female voice
                    },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
                },
                callbacks: {
                    onopen: async () => {
                        console.log("[useGeminiLive] Session established. ID:", currentSessionId);

                        // Handshake delay with ID check
                        await new Promise(resolve => setTimeout(resolve, 600));

                        if (sessionIdRef.current !== currentSessionId) {
                            console.warn("[useGeminiLive] Aborting stale session (onopen check). ID:", currentSessionId);
                            // Do NOT call disconnect here, as it would kill the NEW session
                            return;
                        }

                        addLog("Conectado!", 'system');
                        setConnectionState(ConnectionState.CONNECTED);
                        isConnectedRef.current = true;

                        await requestWakeLock();

                        try {
                            const stream = await navigator.mediaDevices.getUserMedia({
                                audio: { echoCancellation: true, noiseSuppression: true }
                            });

                            // Re-check ID after getUserMedia prompt (User might delay)
                            if (sessionIdRef.current !== currentSessionId) {
                                stream.getTracks().forEach(t => t.stop());
                                return;
                            }

                            streamRef.current = stream;
                            const source = ctx.createMediaStreamSource(stream);
                            audioSourceRef.current = source;
                            source.connect(analyserNode);

                            const processor = ctx.createScriptProcessor(4096, 1, 1);
                            processorNodeRef.current = processor;

                            let logCounter = 0;

                            processor.onaudioprocess = (e) => {
                                if (!isConnectedRef.current || sessionIdRef.current !== currentSessionId) return;
                                const inputData = e.inputBuffer.getChannelData(0);

                                let sum = 0;
                                for (let i = 0; i < inputData.length; i += 8) sum += inputData[i] * inputData[i];
                                const rms = Math.sqrt(sum / (inputData.length / 8));
                                setVolume(rms);

                                if (logCounter++ % 100 === 0) console.log("[useGeminiLive] RMS:", rms.toFixed(4));

                                let processData = inputData;
                                if (ctx.sampleRate !== AUDIO_CONFIG.inputSampleRate) {
                                    processData = downsampleBuffer(inputData, ctx.sampleRate, AUDIO_CONFIG.inputSampleRate);
                                }

                                try {
                                    session.sendRealtimeInput({ media: createPcmBlob(processData) });
                                } catch (err) {
                                    console.warn("[useGeminiLive] Send failed", err);
                                }
                            };

                            source.connect(processor);

                            // CRITICAL: ScriptProcessorNode MUST be connected to destination to fire onaudioprocess.
                            // We use a GainNode with 0 gain to keep it silent and avoid echo.
                            const silentGain = ctx.createGain();
                            silentGain.gain.value = 0;
                            processor.connect(silentGain);
                            silentGain.connect(ctx.destination);
                        } catch (err) {
                            console.error("[useGeminiLive] Mic failed:", err);
                            addLog("Microfone não disponível.", 'system');
                            if (sessionIdRef.current === currentSessionId) disconnect();
                        }
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        if (sessionIdRef.current !== currentSessionId) return;
                        console.log("[useGeminiLive] Message received:", message);

                        const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                        if (base64Audio) console.log("[useGeminiLive] Audio data received, length:", base64Audio.length);
                        if (base64Audio && audioContextRef.current) {
                            const ctx = audioContextRef.current;
                            if (ctx.state === 'suspended') await ctx.resume();

                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                            const audioBuffer = await decodeAudioData(decodeBase64(base64Audio), ctx, AUDIO_CONFIG.outputSampleRate);

                            const source = ctx.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(analyserRef.current!);
                            source.connect(ctx.destination); // Sophie goes to speakers

                            source.addEventListener('ended', () => sourcesRef.current.delete(source));
                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sourcesRef.current.add(source);
                        }

                        if (message.serverContent?.inputTranscription?.text) {
                            console.log("[useGeminiLive] User Transcript:", message.serverContent.inputTranscription.text);
                            currentInputRef.current += message.serverContent.inputTranscription.text;
                        }
                        if (message.serverContent?.outputTranscription?.text) {
                            console.log("[useGeminiLive] Sophie Transcript:", message.serverContent.outputTranscription.text);
                            currentOutputRef.current += message.serverContent.outputTranscription.text;
                        }

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
                        console.log("[useGeminiLive] CLOSED. ID:", currentSessionId, event);
                        if (sessionIdRef.current === currentSessionId) {
                            if (isConnectedRef.current && event?.code !== 1000) {
                                const reason = event?.reason || "Desconhecido";
                                console.error("[useGeminiLive] Server closed connection:", event);
                                alert(`CONEXÃO ENCERRADA PELO SERVIDOR\nCódigo: ${event?.code || 'N/A'}\nMotivo: ${reason}`);
                            }
                            disconnect();
                        }
                    },
                    onerror: (e) => {
                        console.error("[useGeminiLive] ERROR. ID:", currentSessionId, e);
                        if (sessionIdRef.current === currentSessionId) {
                            setConnectionState(ConnectionState.ERROR);
                            disconnect();
                        }
                    }
                }
            });

            sessionRef.current = session;

        } catch (error) {
            console.error("[useGeminiLive] FAILED. ID:", currentSessionId, error);
            if (sessionIdRef.current === currentSessionId) {
                setConnectionState(ConnectionState.ERROR);
                addLog("Falha na conexão.", 'system');
                disconnect();
            }
        }
    };

    useEffect(() => { return () => disconnect("unmount"); }, [disconnect]);

    return { connect, disconnect, clearLogs, connectionState, logs, analyser, volume };
};