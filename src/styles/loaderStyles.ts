import type { CSSProperties } from 'react';

export const loadingOverlayStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999, 
};

export const spinnerStyle: CSSProperties = {
    border: '12px solid #f3f3f3',
    borderTop: '12px solid #3498db',
    borderRadius: '50%',
    width: '80px',
    height: '80px',
    animation: 'spin 1.5s linear infinite',
};

export const spinnerKeyframes = `
    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
`;