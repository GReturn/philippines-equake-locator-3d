export const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: 10,
    left: 10,
    minWidth: '20px',
    maxWidth: '40vh', 
    maxHeight: '100vh', 
    padding: "1rem",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    boxShadow: "-2px 0 8px rgba(0, 0, 0, 0.3)",
    boxSizing: "border-box",
    borderRadius: "5px",
    fontFamily: "Arial, sans-serif",
    fontSize: "18px",
    zIndex: 1000,
    transition: "transform 0.3s ease-in-out",
    overflowY: "auto",
    color: "#ffffff"
};

export const panelHeaderStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid #ccc",
    paddingBottom: "0.5rem",
    color: "#ffffff"
};

export const closeButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    fontSize: "1.5rem",
    cursor: "pointer",
    padding: "0 0.5rem",
    color: "#ffffff"
};

export const listItemStyle: React.CSSProperties = {
    padding: '8px 4px',
    borderBottom: '1px solid #444',
    cursor: 'pointer',
    fontSize: '14px',
    transition: 'background-color 0.2s',
};

export const listItemLocationStyle: React.CSSProperties = {
    display: 'block', 
    fontSize: '12px', 
    color: '#ccc'
};

export const listItemDateStyle: React.CSSProperties = {
    display: 'block', 
    fontSize: '12px', 
    color: '#aaa'
};