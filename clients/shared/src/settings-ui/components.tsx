import { useState, type CSSProperties, type ComponentType, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function SettingsStatusPill({
  ok,
  label,
  onClick,
}: {
  ok: boolean | null;
  label: string;
  onClick?: () => void;
}) {
  const bg = ok === true
    ? "var(--status-connected-bg)"
    : ok === false
      ? "var(--status-error-bg, rgba(220, 38, 38, 0.1))"
      : "var(--input-bg)";
  const color = ok === true
    ? "var(--status-connected-text)"
    : ok === false
      ? "var(--status-error-text, #dc2626)"
      : "var(--text-muted)";

  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        fontWeight: 600,
        padding: "3px 8px",
        borderRadius: 4,
        background: bg,
        color,
        border: `1px solid ${ok === null ? "var(--border-color)" : "transparent"}`,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

export function SettingsSection({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: ComponentType<{ size?: number; color?: string }>;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section
      style={{
        background: "var(--bg-color)",
        border: "1px solid var(--border-color)",
        borderRadius: 6,
        marginBottom: 16,
        boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
        overflow: "hidden",
      }}
    >
      <header
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "var(--input-bg)",
          borderBottom: isOpen ? "1px solid var(--border-color)" : "1px solid transparent",
          cursor: "pointer",
          userSelect: "none",
          transition: "background 0.2s ease, border-color 0.2s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {Icon ? <Icon size={16} color="var(--text-primary)" /> : null}
          <h2
            style={{
              fontSize: 12,
              fontWeight: 600,
              margin: 0,
              color: "var(--text-primary)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {title}
          </h2>
        </div>
        <ChevronDown
          size={16}
          color="var(--text-muted)"
          style={{
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateRows: isOpen ? "1fr" : "0fr",
          transition: "grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <div style={{ padding: "20px 16px" }}>{children}</div>
        </div>
      </div>
    </section>
  );
}

export function SettingsRow({ children, noBorder = false }: { children: ReactNode; noBorder?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 0",
        borderBottom: noBorder ? "none" : "1px solid var(--border-color)",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

export function SettingsField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function settingsButtonStyle(variant: "primary" | "danger" | "ghost" = "ghost"): CSSProperties {
  const common: CSSProperties = {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 4,
    cursor: "pointer",
    border: "1px solid var(--border-color)",
    transition: "all 0.2s ease",
  };
  if (variant === "primary") {
    return { ...common, background: "var(--accent-color)", color: "#fff", border: "1px solid var(--accent-color)", boxShadow: "0 1px 2px rgba(0,0,0,0.1)" };
  }
  if (variant === "danger") {
    return { ...common, background: "transparent", color: "#dc2626", borderColor: "#dc2626" };
  }
  return { ...common, background: "var(--input-bg)", color: "var(--text-primary)" };
}

export const settingsInputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 12,
  borderRadius: 4,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  outline: "none",
  fontFamily: "var(--font-mono, monospace)",
};

export function SettingsModal({
  title,
  onClose,
  children,
  zIndex = 1000,
  minWidth = 320,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  zIndex?: number;
  minWidth?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-color)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          padding: 24,
          minWidth,
          maxWidth: 520,
          width: "90%",
          boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{title}</h3>
          <button onClick={onClose} style={{ ...settingsButtonStyle(), padding: "4px 8px" }}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
