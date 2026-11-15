// PINGVERSE VR entry point: boots the Meta Immersive Web SDK world (WebXR
// session, renderer, player rig, hand input) and hands the frame loop to the game.
import { ReferenceSpaceType, SessionMode, World, createSystem } from '@iwsdk/core';
import { Game } from './game/game.ts';
import { loadFonts } from './hud/fonts.ts';
import type { Host } from './game/game.ts';

async function boot(): Promise<void> {
  const container = document.getElementById('scene') as HTMLElement;
  const status = document.getElementById('status') as HTMLElement;
  const enter = document.getElementById('enter') as HTMLButtonElement;

  // start fetching the UI font while the SDK boots; canvases are drawn only after it loads
  const fontsReady = loadFonts();

  const world = await World.create(container, {
    xr: {
      sessionMode: SessionMode.ImmersiveVR,
      referenceSpace: { type: ReferenceSpaceType.LocalFloor, fallbackOrder: [ReferenceSpaceType.Local] },
      // hand tracking is requested as optional so controllers still work as a fallback
      features: { handTracking: true, layers: true },
      offer: 'always',
    },
    render: { near: 0.03, far: 120, fov: 62 },
    // the game brings its own table tennis physics, paddle tracking and hand-poke UI
    features: { locomotion: false, grabbing: false, physics: false, sceneUnderstanding: false, spatialUI: false },
  });

  const renderer = world.renderer;
  // Quest: fixed foveation keeps the centre sharp and the frame rate stable
  renderer.xr.setFoveation?.(0.7);

  const host: Host = {
    scene: world.scene,
    camera: world.camera,
    renderer,
    rig: world.player,
    canvas: renderer.domElement,
    enterXR: () => world.launchXR(),
    exitXR: () => world.exitXR(),
    setSdkHands: (on) => {
      try {
        const hands = world.input.visualAdapters.hand;
        hands.left.toggleVisual(on);
        hands.right.toggleVisual(on);
      } catch (e) {
        console.warn('could not toggle SDK hand visuals', e);
      }
    },
  };

  await fontsReady;
  const game = new Game(host);

  class GameSystem extends createSystem() {
    update(delta: number): void {
      game.update(delta);
    }
  }
  world.registerSystem(GameSystem);

  const xrOk = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr').catch(() => false));
  status.textContent = xrOk
    ? 'Put on your headset and press Enter VR. Hand tracking recommended - no controllers needed.'
    : 'WebXR is not available in this browser. Desktop preview: move the mouse to swing, click the menu.';
  enter.disabled = !xrOk;
  enter.addEventListener('click', () => {
    game.audio.unlock();
    world.launchXR();
  });
  document.getElementById('overlay')!.classList.add('ready');

  window.addEventListener('beforeunload', () => game.progress.save());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) game.progress.save();
  });
  // handy for debugging from the browser console
  (window as unknown as { pingverse: Game }).pingverse = game;
}

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
