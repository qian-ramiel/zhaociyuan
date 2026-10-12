import { LAppDelegate, s_instance } from './lappdelegate';

let initialized = false;
let activeCanvas: HTMLCanvasElement | null = null;

export async function initializeLive2D(canvas: HTMLCanvasElement, modelUrl: string): Promise<void> {
  if (initialized && activeCanvas !== canvas) disposeLive2D();
  if (!initialized) {
    const delegate = LAppDelegate.getInstance();
    if (!delegate.initialize(canvas)) throw new Error('WebGL initialization failed');
    delegate.run();
    initialized = true;
    activeCanvas = canvas;
  }
  await LAppDelegate.getInstance().getLive2DManager()?.loadModel(modelUrl);
}

export function playLive2DMotion(group: string, index: number, priority = 3): void {
  s_instance?.getLive2DManager()?.playMotion(group, index, priority);
}

export function setLive2DExpression(name: string): void {
  s_instance?.getLive2DManager()?.setExpression(name);
}
export function setLive2DVoiceMouth(value: number): void {
  s_instance?.getLive2DManager()?.setVoiceMouth(value);
}

export function lookAtLive2D(x: number, y: number, head = true): void {
  s_instance?.getLive2DManager()?.setGaze(x, y, head);
}

export function configureLive2DGaze(enabled: boolean, head: boolean): void {
  s_instance?.getLive2DManager()?.configureGaze(enabled, head);
}

export function disposeLive2D(canvas?: HTMLCanvasElement): void {
  if (canvas && canvas !== activeCanvas) return;
  if (!initialized) return;
  LAppDelegate.releaseInstance();
  initialized = false;
  activeCanvas = null;
}

window.addEventListener('beforeunload', () => disposeLive2D(), { passive: true });
