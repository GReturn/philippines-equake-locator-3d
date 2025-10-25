import React, { useEffect, useRef } from 'react';

const panelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 10,
    right: 80,
    minWidth: '250px',
    maxWidth: '400px', 
    maxHeight: '60vh', 
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    borderRadius: '5px',
    zIndex: 1000,
    color: 'white',
    fontFamily: 'Arial, sans-serif',
    boxSizing: 'border-box',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    
    display: 'flex',
    flexDirection: 'column',
}

const panelHeaderStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #ccc',
    padding: '0.75rem 1rem', 
    flexShrink: 0, 
};

const closeButtonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    padding: '0 0.5rem',
    color: 'white',
    lineHeight: 1
};

const contentStyle: React.CSSProperties = {
    padding: '1rem',
    overflowY: 'auto', 
};

interface MasterPanelProps {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    style?: React.CSSProperties;
}

export const MasterPanel: React.FC<MasterPanelProps> = ({ title, onClose, children, style }) => {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if(panelRef.current && !panelRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [onClose]);

    return (
        <div ref={panelRef} style={{ ...panelStyle, ...style }}>
            {/* Panel Header */}
            <div style={panelHeaderStyle}>
                <h4 style={{ margin: 0 }}>{title}</h4>
                <button
                    style={closeButtonStyle}
                    onClick={onClose}
                    aria-label="Close panel"
                >
                    &times; {/* HTML entity for 'X' */}
                </button>
            </div>
            
            <div style={contentStyle}>
                {children}
            </div>
        </div>
    );
}