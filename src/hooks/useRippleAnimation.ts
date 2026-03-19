import { useState, useEffect, useRef } from 'react';

export function useRippleAnimation(isActive: boolean) {
    const [rippleState, setRippleState] = useState({ scale: 0, opacity: 0 });
    const animationFrameRef = useRef<number>(0);

    useEffect(() => {
        if (!isActive) {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            setRippleState({ scale: 0, opacity: 0 });
            return;
        }

        let startTime: number | null = null;
        const animationDuration = 2000;
        const maxScale = 50000;

        const animateRipple = (currentTime: DOMHighResTimeStamp) => {
            if (!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            const progress = (elapsed % animationDuration) / animationDuration;
            
            setRippleState({
                scale: progress * maxScale,
                opacity: Math.max(0, 0.7 - progress * 0.7)
            });
            
            animationFrameRef.current = requestAnimationFrame(animateRipple);
        };

        animationFrameRef.current = requestAnimationFrame(animateRipple);
        return () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [isActive]);

    return rippleState;
}
