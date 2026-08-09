/**
 * Client entry point — wires the network, the DOM overlay and the Phaser scene
 * together. It holds no game rules: it forwards input up to the server and
 * renders whatever the server says is true.
 */

import Phaser from 'phaser';
import type { GameSnapshot, ServerMessage } from '@scorched/protocol';
import { BattleScene, VIEW_HEIGHT, VIEW_WIDTH } from './scenes/battle.ts';
import { createRoom, NetClient } from './net.ts';
import { Ui } from './ui.ts';

interface AppState {
  net: NetClient | null;
  you: string | null;
  snapshot: GameSnapshot | null;
  roomCode: string | null;
}

const app: AppState = { net: null, you: null, snapshot: null, roomCode: null };

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  width: VIEW_WIDTH,
  height: VIEW_HEIGHT,
  // The same near-black as the starfield's own base. A camera shake slides the
  // whole scene, and whatever colour shows in the gutter it opens at the edge
  // is a flashing border unless it matches the sky.
  backgroundColor: '#03030c',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    pixelArt: true,
    antialias: false,
  },
  scene: [BattleScene],
});

function battleScene(): BattleScene | null {
  const scene = game.scene.getScene(BattleScene.KEY);
  return scene instanceof BattleScene ? scene : null;
}

const AIM_BROADCAST_INTERVAL_MS = 80;
let pendingAim: { angleDeg: number; power: number; weapon: string } | null = null;
let aimTimer: number | null = null;

/** Send at most one aim frame per interval, always carrying the latest value. */
function queueAimBroadcast(angleDeg: number, power: number, weapon: string): void {
  pendingAim = { angleDeg, power, weapon };
  if (aimTimer !== null) return;
  aimTimer = window.setTimeout(() => {
    aimTimer = null;
    const aim = pendingAim;
    pendingAim = null;
    if (aim !== null) {
      app.net?.send({ t: 'aim', angleDeg: aim.angleDeg, power: aim.power, weapon: aim.weapon });
    }
  }, AIM_BROADCAST_INTERVAL_MS);
}

const ui = new Ui({
  onCreateRoom: (name) => {
    ui.clearTitleError();
    void createRoom()
      .then((roomCode) => join(name, roomCode))
      .catch((error: unknown) => {
        ui.showTitleError(error instanceof Error ? error.message : 'Could not create a room');
      });
  },

  onJoinRoom: (name, roomCode) => {
    ui.clearTitleError();
    join(name, roomCode);
  },

  onStart: () => app.net?.send({ t: 'start' }),

  onLeave: () => {
    app.net?.close();
    app.net = null;
    app.snapshot = null;
    ui.show('title');
  },

  // Aim updates are cosmetic — they only let opponents watch the barrel swing.
  // Holding an arrow key generates one per frame, so they are coalesced into a
  // trailing send: opponents see smooth movement, the socket sees ~12 frames a
  // second instead of hundreds.
  onAimChange: (angleDeg, power, weapon) => {
    queueAimBroadcast(angleDeg, power, weapon);
  },

  onFire: () => {
    const snapshot = app.snapshot;
    if (snapshot === null) return;
    const aim = ui.aim;
    app.net?.send({
      t: 'fire',
      turnNumber: snapshot.turnNumber,
      angleDeg: aim.angleDeg,
      power: aim.power,
      weapon: aim.weapon,
    });
  },

  onBuy: (weapon) => app.net?.send({ t: 'buy', weapon, quantity: 1 }),
  onSell: (weapon) => app.net?.send({ t: 'sell', weapon }),
  onShopDone: () => app.net?.send({ t: 'shopDone' }),

  onBackToTitle: () => {
    app.net?.close();
    app.net = null;
    app.snapshot = null;
    ui.show('title');
  },
});

ui.show('title');
ui.setAim(45, 60);

function join(name: string, roomCode: string): void {
  app.net?.close();
  app.roomCode = roomCode;

  const net = new NetClient(roomCode, name, {
    onMessage: handleMessage,
    onStatus: (status) => {
      if (status === 'reconnecting') ui.showToast('Connection lost — reconnecting…');
      if (status === 'open' && app.snapshot !== null) ui.showToast('Reconnected.');
    },
    onProtocolError: (detail) => {
      console.error('Protocol error:', detail);
      ui.showToast(`Protocol error: ${detail}`);
    },
  });

  app.net = net;
  net.connect();
  ui.show('lobby');
}

function handleMessage(message: ServerMessage): void {
  switch (message.t) {
    case 'welcome':
      app.you = message.you;
      app.roomCode = message.roomCode;
      return;

    case 'lobby':
      if (app.snapshot === null) ui.show('lobby');
      ui.renderLobby(message.roomCode, message.players, message.hostId, app.you ?? '');
      return;

    case 'state':
      applySnapshot(message.snapshot);
      return;

    case 'events': {
      const scene = battleScene();
      if (scene === null) {
        applySnapshot(message.snapshot);
        return;
      }
      // Lock input while the shell is in the air.
      ui.renderHud(message.snapshot, app.you ?? '', false);
      void scene.playEvents(message.events, message.snapshot).then(() => {
        applySnapshot(message.snapshot);
      });
      app.snapshot = message.snapshot;
      return;
    }

    case 'aim':
      // Opponent moved their barrel — purely cosmetic.
      return;

    case 'chat':
      return;

    case 'error':
      ui.showToast(message.message);
      if (message.code === 'room_full' || message.code === 'bad_protocol') {
        ui.showTitleError(message.message);
        ui.show('title');
      }
      return;

    case 'pong':
      return;

    default:
      return;
  }
}

function applySnapshot(snapshot: GameSnapshot): void {
  app.snapshot = snapshot;
  const you = app.you ?? '';
  const scene = battleScene();
  scene?.render(snapshot);

  switch (snapshot.phase) {
    case 'shopping':
      ui.show('shop');
      ui.renderShop(snapshot, you);
      ui.renderHud(snapshot, you, false);
      return;
    case 'gameover':
      ui.show('gameover');
      ui.renderGameOver(snapshot);
      return;
    default: {
      ui.show('battle');
      const active = snapshot.tanks[snapshot.activeTank];
      const canFire =
        snapshot.phase === 'aiming' &&
        active !== undefined &&
        active.id === you &&
        !(scene?.isAnimating ?? false);
      ui.renderHud(snapshot, you, canFire);
    }
  }
}

// Expose a tiny read-only handle so Playwright can assert on authoritative
// state (terrain hash, health, turn number) without scraping pixels.
declare global {
  interface Window {
    __scorched?: {
      snapshot(): GameSnapshot | null;
      you(): string | null;
      roomCode(): string | null;
    };
  }
}

window.__scorched = {
  snapshot: () => app.snapshot,
  you: () => app.you,
  roomCode: () => app.roomCode,
};
