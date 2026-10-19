const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

// --- GAME CONSTANTS ---
const WORLD_SIZE = 5000;
const TOTAL_SNAKES = 15;
const MAX_FOOD = 1000;
const GRID_SIZE = 250;
const BOT_NAMES = ['Viper', 'Mamba', 'Anaconda', 'Cobra', 'Python', 'Shadow', 'Blaze', 'Titan', 'Frost', 'Zenith', 'Phantom', 'Wraith', 'Rogue', 'Apex', 'Nova'];
const SKINS = ['#38BDF8', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#EF4444', '#14B8A6', '#F43F5E'];

// --- GAME STATE ---
let snakes = {};
let foods = {};
let powerups = {};
let ejectedMass = {};
let botsEnabled = true;

// --- UTILITIES & ID GENERATION ---
const genId = () => Math.random().toString(36).substr(2, 9);
const randomPos = () => Math.random() * (WORLD_SIZE - 400) + 200;

// --- SPATIAL HASH GRID (Optimization) ---
class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = {};
  }
  hash(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }
  insert(entity) {
    const key = this.hash(entity.x, entity.y);
    if (!this.cells[key]) this.cells[key] = [];
    this.cells[key].push(entity);
  }
  clear() {
    this.cells = {};
  }
  getNearby(x, y, radius) {
    const nearby = [];
    const minKeyX = Math.floor((x - radius) / this.cellSize);
    const maxKeyX = Math.floor((x + radius) / this.cellSize);
    const minKeyY = Math.floor((y - radius) / this.cellSize);
    const maxKeyY = Math.floor((y + radius) / this.cellSize);

    for (let i = minKeyX; i <= maxKeyX; i++) {
      for (let j = minKeyY; j <= maxKeyY; j++) {
        const key = `${i},${j}`;
        if (this.cells[key]) nearby.push(...this.cells[key]);
      }
    }
    return nearby;
  }
}
const grid = new SpatialHash(GRID_SIZE);

// --- INITIAL SPAWN ---
for (let i = 0; i < MAX_FOOD; i++) spawnFood();
for (let i = 0; i < 15; i++) spawnPowerup();

function spawnFood(x, y, color, size, isDrop = false) {
  const id = genId();
  foods[id] = {
    id,
    x: x || Math.random() * WORLD_SIZE,
    y: y || Math.random() * WORLD_SIZE,
    color: color || SKINS[Math.floor(Math.random() * SKINS.length)],
    size: size || Math.random() * 3 + 3,
    isDrop
  };
}

function spawnPowerup() {
  const types = ['MAGNET', 'SPEED', 'SHIELD'];
  const id = genId();
  powerups[id] = {
    id,
    type: types[Math.floor(Math.random() * types.length)],
    x: Math.random() * WORLD_SIZE,
    y: Math.random() * WORLD_SIZE,
    size: 15
  };
}

function createSnake(id, name, color, isBot = false) {
  const x = randomPos(), y = randomPos();
  const body = [];
  for (let i = 0; i < 15; i++) body.push({ x: x - i * 6, y });

  return {
    id, name, color, isBot, x, y,
    angle: Math.random() * Math.PI * 2,
    targetAngle: Math.random() * Math.PI * 2,
    score: 15, kills: 0, level: 1,
    body, isBoosting: false, dead: false,
    stamina: 100, maxStamina: 100,
    powerup: null, powerupTimer: 0,
    botState: 'WANDER' // WANDER, HUNT, FLEE, SCAVENGE
  };
}

function maintainBots() {
  if (!botsEnabled) return;
  const activeCount = Object.values(snakes).filter(s => !s.dead).length;
  if (activeCount < TOTAL_SNAKES) {
    const botId = 'bot_' + genId();
    snakes[botId] = createSnake(botId, BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], SKINS[Math.floor(Math.random() * SKINS.length)], true);
  }
}

// --- SOCKET HANDLING ---
io.on('connection', (socket) => {
  socket.on('joinGame', ({ username, skin }) => {
    snakes[socket.id] = createSnake(socket.id, username || 'Player', skin, false);
    socket.emit('init', { id: socket.id, worldSize: WORLD_SIZE });
    io.emit('killFeed', { message: `${snakes[socket.id].name} joined the arena!`, color: '#10B981' });
  });

  socket.on('playerInput', ({ angle, isBoosting }) => {
    if (snakes[socket.id] && !snakes[socket.id].dead) {
      snakes[socket.id].targetAngle = angle;
      snakes[socket.id].isBoosting = isBoosting;
    }
  });

  socket.on('ejectMass', () => {
    const s = snakes[socket.id];
    if (s && !s.dead && s.score > 25) {
      s.score -= 5;
      const ejectX = s.x + Math.cos(s.angle) * 30;
      const ejectY = s.y + Math.sin(s.angle) * 30;
      const eId = genId();
      ejectedMass[eId] = {
        id: eId, x: ejectX, y: ejectY, color: s.color, size: 8,
        vx: Math.cos(s.angle) * 15, vy: Math.sin(s.angle) * 15
      };
    }
  });

  socket.on('toggleBots', () => {
    botsEnabled = !botsEnabled;
    if (!botsEnabled) Object.values(snakes).forEach(s => { if (s.isBot) killSnake(s); });
    io.emit('botsToggled', botsEnabled);
  });

  socket.on('disconnect', () => { delete snakes[socket.id]; });
});

// --- CORE GAME LOOP (45 FPS) ---
setInterval(() => {
  maintainBots();
  grid.clear();
  const snakeList = Object.values(snakes);
  
  // Populate spatial hash
  Object.values(foods).forEach(f => grid.insert(f));
  Object.values(powerups).forEach(p => grid.insert(p));
  Object.values(ejectedMass).forEach(e => grid.insert(e));
  snakeList.forEach(s => { if (!s.dead) { s.body.forEach(seg => grid.insert({ ...seg, isBody: true, owner: s.id })); } });

  // Update Ejected Mass Physics
  Object.values(ejectedMass).forEach(e => {
    e.x += e.vx; e.y += e.vy;
    e.vx *= 0.9; e.vy *= 0.9; // Friction
    if (Math.abs(e.vx) < 0.1) {
      spawnFood(e.x, e.y, e.color, e.size, true);
      delete ejectedMass[e.id];
    }
  });

  snakeList.forEach((s) => {
    if (s.dead) return;

    // Powerup Timers
    if (s.powerupTimer > 0) {
      s.powerupTimer--;
      if (s.powerupTimer <= 0) s.powerup = null;
    }

    // Stamina & Boosting
    if (s.isBoosting && s.stamina > 0 && s.score > 15) {
      s.stamina -= 1.5;
      s.score -= 0.1;
    } else {
      s.isBoosting = false;
      if (s.stamina < s.maxStamina) s.stamina += 0.5;
    }

    let speed = (s.isBoosting ? 11 : 6) + (s.powerup === 'SPEED' ? 4 : 0);

    // AI BOT LOGIC (State Machine)
    if (s.isBot) {
      const nearbySnakes = snakeList.filter(o => o.id !== s.id && Math.hypot(o.x - s.x, o.y - s.y) < 300);
      const nearbyFood = grid.getNearby(s.x, s.y, 200).filter(item => !item.isBody);

      if (s.x < 200 || s.x > WORLD_SIZE - 200 || s.y < 200 || s.y > WORLD_SIZE - 200) {
        s.targetAngle = Math.atan2(WORLD_SIZE / 2 - s.y, WORLD_SIZE / 2 - s.x);
        s.botState = 'WANDER';
      } else if (nearbySnakes.some(o => o.score > s.score + 50)) {
        s.botState = 'FLEE';
        const threat = nearbySnakes.find(o => o.score > s.score + 50);
        s.targetAngle = Math.atan2(s.y - threat.y, s.x - threat.x);
        s.isBoosting = s.stamina > 20;
      } else if (nearbySnakes.length > 0 && s.score > nearbySnakes[0].score + 20) {
        s.botState = 'HUNT';
        s.targetAngle = Math.atan2(nearbySnakes[0].y - s.y, nearbySnakes[0].x - s.x);
        s.isBoosting = s.stamina > 50;
      } else if (nearbyFood.length > 0) {
        s.botState = 'SCAVENGE';
        const bestFood = nearbyFood.reduce((prev, curr) => (curr.size > prev.size ? curr : prev));
        s.targetAngle = Math.atan2(bestFood.y - s.y, bestFood.x - s.x);
        s.isBoosting = false;
      } else {
        s.botState = 'WANDER';
        if (Math.random() < 0.05) s.targetAngle += (Math.random() - 0.5);
      }
    }

    // Smooth Turning
    let angleDiff = s.targetAngle - s.angle;
    angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
    s.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), 0.15);

    s.x += Math.cos(s.angle) * speed;
    s.y += Math.sin(s.angle) * speed;

    // Bounds Kill
    if (s.x < 0 || s.x > WORLD_SIZE || s.y < 0 || s.y > WORLD_SIZE) return killSnake(s, null);

    s.body.unshift({ x: s.x, y: s.y });
    const targetLength = Math.floor(15 + (s.score - 15) * 1.5);
    while (s.body.length > targetLength) s.body.pop();

    // Eating Logic via Spatial Hash
    const eatRadius = s.powerup === 'MAGNET' ? 150 : 20 + s.score / 50;
    const nearbyItems = grid.getNearby(s.x, s.y, eatRadius);
    
    nearbyItems.forEach(item => {
      if (item.isBody) return;
      const dist = Math.hypot(s.x - item.x, s.y - item.y);
      
      if (foods[item.id] && dist < eatRadius) {
        // Magnet pull effect simulation on client, instant eat on server
        s.score += item.isDrop ? 3 : 1;
        delete foods[item.id];
        spawnFood(); // Respawn to maintain count
      } else if (powerups[item.id] && dist < eatRadius) {
        s.powerup = item.type;
        s.powerupTimer = 45 * 10; // 10 seconds
        delete powerups[item.id];
        setTimeout(spawnPowerup, 5000);
      } else if (ejectedMass[item.id] && dist < eatRadius) {
        s.score += 5;
        delete ejectedMass[item.id];
      }
    });

    // Level up logic
    const newLevel = Math.floor(s.score / 50) + 1;
    if (newLevel > s.level) { s.level = newLevel; s.maxStamina += 10; s.stamina = s.maxStamina; }

    // PvP Collisions
    if (s.powerup === 'SHIELD') return; // Invincible
    for (let other of snakeList) {
      if (other.id === s.id || other.dead) continue;
      for (let i = 4; i < other.body.length; i += 2) {
        const radius = 12 + other.score / 100;
        if (Math.hypot(s.x - other.body[i].x, s.y - other.body[i].y) < radius) {
          killSnake(s, other);
          return;
        }
      }
    }
  });

  io.emit('gameState', { snakes, foods, powerups, ejectedMass });
}, 1000 / 45);

function killSnake(victim, killer) {
  victim.dead = true;
  // Drop mass
  for (let i = 0; i < victim.body.length; i += 2) {
    spawnFood(victim.body[i].x + (Math.random() - 0.5) * 30, victim.body[i].y + (Math.random() - 0.5) * 30, victim.color, Math.min(victim.score / 10, 15), true);
  }
  
  if (killer) {
    killer.kills++;
    killer.score += victim.score * 0.25; // Steal 25% of score instantly
    io.emit('killFeed', { message: `⚔️ ${killer.name} decimated ${victim.name}!`, color: killer.color });
    io.to(killer.id).emit('screenShake', 10);
  } else {
    io.emit('killFeed', { message: `💀 ${victim.name} slithered into the void.`, color: '#EF4444' });
  }
  
  io.to(victim.id).emit('deathStats', { score: Math.floor(victim.score), kills: victim.kills, level: victim.level });
  setTimeout(() => delete snakes[victim.id], 100);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pro Server live on ${PORT}`));
