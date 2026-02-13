import React, { useState, useEffect, useRef } from 'react';
import { useGeminiLive } from './hooks/useGeminiLive';
import Visualizer from './components/Visualizer';
import { ConnectionState } from './types';

// Icons
const TowerIcon = ({ className = "w-6 h-6" }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21V9m0 0l-3 3m3-3l3 3m-3-3V5.25a2.25 2.25 0 114.5 0V7.5a.75.75 0 01-.75.75H8.25a.75.75 0 01-.75-.75V5.25a2.25 2.25 0 114.5 0v3.75zM3.375 19.5h17.25m-17.25 3h17.25M9 21v-6h6v6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2.25a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM12 9l-2.5 5h5L12 9z" />
    </svg>
);

const StopIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 md:w-6 md:h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
    </svg>
);

const PhoneIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 md:w-6 md:h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
    </svg>
);

const TrashIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 md:w-5 md:h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
);

const DownloadIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 md:w-5 md:h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
);

const App: React.FC = () => {
    const { connect, disconnect, clearLogs, connectionState, analyser, logs } = useGeminiLive();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [showToast, setShowToast] = useState(false);
    const [toastMessage, setToastMessage] = useState('');

    // Reliable auto-scroll to bottom of chat
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [logs]);

    // Show restore notification on mount if logs exist
    useEffect(() => {
        if (logs.length > 0 && !showToast) {
            setToastMessage('Sessão restaurada com sucesso.');
            setShowToast(true);
            const timer = setTimeout(() => setShowToast(false), 3000);
            return () => clearTimeout(timer);
        }
    }, []); // Run once on mount

    const handleDownload = () => {
        if (logs.length === 0) return;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const textContent = logs.map(log => {
            const time = new Date(log.timestamp).toLocaleTimeString();
            const role = log.role === 'user' ? 'Você' : (log.role === 'model' ? 'Sophie' : 'Sistema');
            return `[${time}] ${role}: ${log.text}`;
        }).join('\n\n');

        const blob = new Blob([textContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fluent-french-backup-${timestamp}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setToastMessage('Backup salvo com sucesso.');
        setShowToast(true);
        setTimeout(() => setShowToast(false), 3000);
    };

    const isConnected = connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.CONNECTING;

    return (
        // Using h-[100dvh] ensures it fits the mobile screen correctly even with address bars
        <div className="flex flex-col h-[100dvh] w-full bg-slate-950 text-slate-50 relative overflow-hidden font-sans">
            
            {/* Background Ambience (Blue Theme) */}
            <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
                <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[60%] bg-blue-600/20 rounded-full blur-[120px] mix-blend-screen animate-pulse"></div>
                <div className="absolute bottom-[-20%] right-[-20%] w-[60%] h-[60%] bg-indigo-600/20 rounded-full blur-[120px] mix-blend-screen"></div>
            </div>

            {/* Toast Notification */}
            <div className={`absolute top-20 left-1/2 -translate-x-1/2 z-50 transition-all duration-500 ${showToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'}`}>
                <div className="bg-emerald-500/90 text-white text-xs md:text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-md border border-emerald-400/30 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {toastMessage}
                </div>
            </div>

            {/* Header */}
            <header className="relative z-10 flex items-center justify-center px-4 md:px-6 bg-slate-900/60 backdrop-blur-md border-b border-slate-800/50 shrink-0 h-16 shadow-sm">
                <div className="flex items-center gap-2 md:gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30 text-white shrink-0">
                        <TowerIcon />
                    </div>
                    <h1 className="text-lg font-bold tracking-tight text-slate-100 leading-none flex items-baseline">
                        FluentFrench <span className="text-xs md:text-sm font-medium text-slate-400 mx-1.5 lowercase">avec</span> Beraldo
                    </h1>
                </div>
                
                <div className="absolute right-4 md:right-6 flex items-center">
                    <span className={`flex items-center gap-2 px-2 md:px-3 py-1 rounded-full text-xs font-medium border transition-colors duration-300 ${
                        connectionState === ConnectionState.CONNECTED 
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            : connectionState === ConnectionState.CONNECTING
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                            : 'bg-slate-800 border-slate-700 text-slate-400'
                    }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                             connectionState === ConnectionState.CONNECTED ? 'bg-emerald-400 animate-pulse' : 
                             connectionState === ConnectionState.CONNECTING ? 'bg-amber-400 animate-bounce' : 'bg-slate-500'
                        }`}></span>
                        <span className="hidden md:inline">
                            {connectionState === ConnectionState.CONNECTED ? 'Sophie Online' : 
                             connectionState === ConnectionState.CONNECTING ? 'Conectando...' : 'Offline'}
                        </span>
                        <span className="md:hidden">
                            {connectionState === ConnectionState.CONNECTED ? 'Online' : 
                             connectionState === ConnectionState.CONNECTING ? '...' : 'Offline'}
                        </span>
                    </span>
                </div>
            </header>

            {/* Main Content Area - Vertical Layout with DVH calc */}
            <main className="flex-1 relative z-10 flex flex-col p-2 md:p-4 gap-3 md:gap-4 overflow-hidden h-[calc(100dvh-64px)]">
                
                {/* Top: Visualizer Area 
                    Mobile: 35% height to give more room for text
                    Desktop: 45% height 
                */}
                <div className="relative w-full h-[35%] md:h-[45%] shrink-0 transition-all duration-500">
                    <div className="relative w-full h-full bg-slate-900/40 rounded-2xl border border-slate-800/50 overflow-hidden shadow-2xl backdrop-blur-sm flex flex-col">
                        
                        {/* Visualizer Canvas */}
                        <div className="absolute inset-0 z-10 opacity-90">
                            <Visualizer 
                                analyser={analyser} 
                                isActive={connectionState === ConnectionState.CONNECTED} 
                                color="#60a5fa" // Blue-400
                            />
                        </div>

                        {/* Overlay Content */}
                        <div className="relative z-20 flex-1 flex flex-col items-center justify-center p-4 text-center">
                            {/* Persistent Container */}
                            <div className="space-y-2 md:space-y-6 animate-in fade-in zoom-in duration-500 flex flex-col items-center -translate-y-6 md:-translate-y-4">
                                <div className="inline-block p-2 md:p-4 rounded-full bg-slate-800/60 border border-slate-700 shadow-xl shadow-blue-900/20 scale-100 backdrop-blur-md">
                                    <div className="w-12 h-12 md:w-20 md:h-20 rounded-full bg-gradient-to-tr from-blue-400 to-indigo-500 flex items-center justify-center shadow-inner text-white">
                                            <div className="w-6 h-6 md:w-10 md:h-10 flex items-center justify-center">
                                                <TowerIcon className="w-full h-full p-0.5 md:p-1" />
                                            </div>
                                    </div>
                                </div>
                                <div className="rounded-xl backdrop-blur-sm p-1 md:p-2 flex flex-col gap-1.5">
                                    <h2 className="text-base md:text-2xl font-light text-slate-200">
                                        {isConnected ? 'Sophie ouvindo...' : 'Bonjour, Sophie ici'}
                                    </h2>
                                    <p className="text-slate-400 text-[10px] md:text-sm max-w-[200px] md:max-w-xs mx-auto text-shadow-sm leading-tight">
                                        Sua tutora de IA. Vamos praticar francês?
                                    </p>
                                </div>
                                
                                {isConnected ? (
                                    <button
                                        onClick={disconnect}
                                        className="mt-1 px-5 py-2 md:px-8 md:py-3 bg-red-500 hover:bg-red-600 text-white rounded-full font-medium transition-all shadow-lg shadow-red-500/30 hover:shadow-red-500/50 flex items-center gap-2 mx-auto text-xs md:text-base backdrop-blur-md border border-red-400/20"
                                    >
                                        <StopIcon />
                                        Encerrar
                                    </button>
                                ) : (
                                    <button
                                        onClick={connect}
                                        className="mt-1 px-5 py-2 md:px-8 md:py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-full font-medium transition-all shadow-lg shadow-blue-600/30 hover:shadow-blue-600/50 flex items-center gap-2 mx-auto text-xs md:text-base"
                                    >
                                        <PhoneIcon />
                                        Começar
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Bottom: Chat Transcript (Remaining Height) */}
                <div className="flex flex-col flex-1 bg-slate-900/40 rounded-2xl border border-slate-800/50 backdrop-blur-md overflow-hidden shadow-inner">
                    <div className="px-4 py-2 md:px-5 md:py-3 border-b border-slate-800/50 bg-slate-950/30 flex justify-between items-center shrink-0 h-10 md:h-12">
                        <h3 className="text-xs md:text-sm font-semibold text-blue-200 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span>
                            Transcrição
                        </h3>
                        <div className="flex items-center gap-2 md:gap-3">
                            {logs.length > 0 && (
                                <>
                                    <button
                                        onClick={handleDownload}
                                        className="text-slate-400 hover:text-blue-400 transition-colors p-1.5 rounded-full hover:bg-slate-800 flex items-center gap-1.5 bg-slate-800/50 border border-slate-700/50"
                                        title="Baixar histórico"
                                    >
                                        <DownloadIcon />
                                        <span className="hidden md:inline text-[10px] font-medium uppercase tracking-wider pr-1">Backup</span>
                                    </button>
                                    <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                    <button 
                                        onClick={clearLogs}
                                        className="text-slate-500 hover:text-red-400 transition-colors p-1.5 rounded-full hover:bg-slate-800"
                                        title="Limpar conversa"
                                    >
                                        <TrashIcon />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-3 md:space-y-4 scrollbar-hide scroll-smooth">
                        {logs.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-2 opacity-60">
                                <div className="p-2 bg-slate-800/50 rounded-full">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                                    </svg>
                                </div>
                                <p className="text-xs text-center px-4">A transcrição aparecerá aqui.</p>
                            </div>
                        ) : (
                            logs.map((log, index) => {
                                if (log.role === 'system') {
                                    return (
                                        <div key={index} className="flex justify-center my-2 md:my-4">
                                            <span className="text-[9px] md:text-[10px] uppercase tracking-widest text-slate-500 bg-slate-900/60 px-2 py-0.5 rounded-full border border-slate-800">
                                                {log.text}
                                            </span>
                                        </div>
                                    );
                                }
                                
                                const isUser = log.role === 'user';
                                return (
                                    <div key={index} className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 duration-300`}>
                                        <div className={`
                                            max-w-[90%] md:max-w-[80%] rounded-2xl px-4 py-2.5 md:px-5 md:py-3 text-sm leading-relaxed shadow-md break-words
                                            ${isUser 
                                                ? 'bg-blue-600 text-white rounded-br-none border border-blue-500' 
                                                : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
                                            }
                                        `}>
                                            {!isUser && (
                                                <div className="text-[10px] md:text-xs text-blue-300 font-bold mb-1 tracking-wide flex items-center gap-1">
                                                    Sophie
                                                </div>
                                            )}
                                            {log.text}
                                        </div>
                                    </div>
                                );
                            })
                        )}
                        <div ref={messagesEndRef} className="h-1" />
                    </div>
                </div>
            </main>
        </div>
    );
};

export default App;