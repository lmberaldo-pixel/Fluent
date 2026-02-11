export interface AudioConfig {
    inputSampleRate: number;
    outputSampleRate: number;
}

export enum ConnectionState {
    DISCONNECTED = 'DISCONNECTED',
    CONNECTING = 'CONNECTING',
    CONNECTED = 'CONNECTED',
    ERROR = 'ERROR',
}

export interface LogMessage {
    role: 'user' | 'model' | 'system';
    text: string;
    timestamp: Date;
}