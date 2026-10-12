import type { Appearance, Companion, CompanionMode, DesktopPreferences, ScreenSettings } from './renderer/src/types';
export function screenState(desktop?: DesktopPreferences, screen?: ScreenSettings, mode?: CompanionMode, unavailable?: boolean): { allowed: boolean; reason: string };
export function proactiveState(desktop: DesktopPreferences, companion: Companion, mode: CompanionMode, now?: Date, unavailable?: boolean): { allowed: boolean; reason: string };
export function gazeState(desktop?: DesktopPreferences, appearance?: Appearance): string;
