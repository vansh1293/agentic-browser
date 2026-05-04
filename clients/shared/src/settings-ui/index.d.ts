import type { CSSProperties, ComponentType, ReactNode } from "react";

export function SettingsStatusPill(props: { ok: boolean | null; label: string; onClick?: () => void }): ReactNode;
export function SettingsSection(props: { title: string; icon?: ComponentType<{ size?: number; color?: string }>; defaultOpen?: boolean; children: ReactNode }): ReactNode;
export function SettingsRow(props: { children: ReactNode; noBorder?: boolean }): ReactNode;
export function SettingsField(props: { label: string; children: ReactNode }): ReactNode;
export function settingsButtonStyle(variant?: "primary" | "danger" | "ghost"): CSSProperties;
export const settingsInputStyle: CSSProperties;
export function SettingsModal(props: { title: string; onClose: () => void; children: ReactNode; zIndex?: number; minWidth?: number }): ReactNode;
