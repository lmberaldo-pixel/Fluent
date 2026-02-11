import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
    analyser: AnalyserNode | null;
    isActive: boolean;
    color?: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ analyser, isActive, color = '#6366f1' }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number>();

    useEffect(() => {
        if (!analyser || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size for high DPI
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            if (!isActive) {
                ctx.clearRect(0, 0, rect.width, rect.height);
                return;
            }

            requestRef.current = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);

            ctx.clearRect(0, 0, rect.width, rect.height);

            const barWidth = (rect.width / bufferLength) * 2.5;
            let barHeight;
            let x = 0;

            // Draw mirrored visualization from center
            const centerX = rect.width / 2;

            for (let i = 0; i < bufferLength; i++) {
                barHeight = (dataArray[i] / 255) * (rect.height * 0.8);

                // Use gradient
                const gradient = ctx.createLinearGradient(0, rect.height / 2 - barHeight, 0, rect.height / 2 + barHeight);
                gradient.addColorStop(0, `${color}00`);
                gradient.addColorStop(0.5, color);
                gradient.addColorStop(1, `${color}00`);

                ctx.fillStyle = gradient;

                // Draw centered bars
                ctx.fillRect(centerX + x, (rect.height - barHeight) / 2, barWidth, barHeight);
                ctx.fillRect(centerX - x - barWidth, (rect.height - barHeight) / 2, barWidth, barHeight);

                x += barWidth + 1;
                
                // Optimize: stop if off screen
                if (x > centerX) break;
            }
        };

        draw();

        return () => {
            if (requestRef.current) {
                cancelAnimationFrame(requestRef.current);
            }
        };
    }, [analyser, isActive, color]);

    return (
        <canvas 
            ref={canvasRef} 
            className="w-full h-full"
            style={{ width: '100%', height: '100%' }}
        />
    );
};

export default Visualizer;