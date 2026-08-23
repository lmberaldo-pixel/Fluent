export interface AudioConfig {
    inputSampleRate: number;
    outputSampleRate: number;
}

export const ConnectionState = {
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    ERROR: 'ERROR',
} as const;

export type ConnectionState = typeof ConnectionState[keyof typeof ConnectionState];

export interface LogMessage {
    role: 'user' | 'model' | 'system';
    text: string;
    timestamp: Date;
}