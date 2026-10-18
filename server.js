const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const WORLD_SIZE = 3000;
const TOTAL_SNAKES = 10;
const BOT_NAMES = ['Viper', 'Mamba', 'Anaconda', 'Cobra', 'Python', 'Shadow', 'Blaze', 'Titan', 'Frost', 'Zenith'];
const SKINS = ['#38BDF8', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#EF4444'];

let snakes = {};
let foods = [];
let botsEnabled = true;

// Spawn initial food grid
for (let i = 0; i < 500; i++) {
  foods.push({
    id: Math.random().toString(36).substring(2, 7),
    x: Math.random() * WORLD_SIZE,
    y: Math.random() * WORLD_SIZE,
    color: SKINS[Math.floor(Math.random() * SKINS.length)],
    size: Math.random() * 3 + 3
  });
}

function createSnake(id, name, color, isBot = false) {
  const x = Math.random() * (WORLD_SIZE - 400) + 200;
  const y = Math.random() * (WORLD_SIZE - 400) + 200;
  const score = 15;
  const body = [];
  for (let i = 0; i < score; i++) body.push({ x: x - i * 6, y });

  return { id, name, color, isBot, x, y, angle: Math.random() * Math.PI * 2, targetAngle: Math.random() * Math.PI * 2, score, body, isBoosting: false, dead: false };
}

function maintainBots() {
  if (!botsEnabled) return;
  const activeSnakes = Object.values(snakes).filter(s => !s.dead);
  if (activeSnakes.length < TOTAL_SNAKES) {
    const botId = 'bot_' + Math.random().toString(36).substring(2, 7);
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + '_' + Math.floor(Math.random() * 99);
    const color = SKINS[Math.floor(Math.random() * SKINS.length)];
    snakes[botId] = createSnake(botId, name, color, true);
  }
}

io.on('connection', (socket) => {
  socket.on('joinGame', ({ username, skin }) => {
    snakes[socket.id] = createSnake(socket.id, username || 'Ghost', skin || '#38BDF8', false);
    socket.emit('init', { id: socket.id, worldSize: WORLD_SIZE, botsEnabled });
  });

  socket.on('playerInput', ({ angle, isBoosting }) => {
    if (snakes[socket.id] && !snakes[socket.id].dead) {
      snakes[socket.id].targetAngle = angle;
      snakes[socket.id].isBoosting = isBoosting;
    }
  });

  socket.on('toggleBots', () => {
    botsEnabled = !botsEnabled;
    if (!botsEnabled) {
      Object.values(snakes).forEach(s => { if (s.isBot) killSnake(s); });
    }
    io.emit('botsToggled', botsEnabled);
  });

  socket.on('disconnect', () => { delete snakes[socket.id]; });
});

// Server Game Loop - Running at 40 Ticks for buttery smoothness
setInterval(() => {
  maintainBots();
  const snakeList = Object.values(snakes);

  snakeList.forEach((s) => {
    if (s.dead) return;

    // Smooth turning logic (Snake glides into turns rather than snapping)
    let angleDiff = s.targetAngle - s.angle;
    angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
    s.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), 0.18); // Turn speed limit

    // Faster Base Movement
    let speed = s.isBoosting && s.score > 8 ? 10.5 : 5.5;
    if (s.isBoosting && s.score > 8) s.score -= 0.08;

    // SMART AI LOGIC
    if (s.isBot) {
      let danger = false;
      s.isBoosting = false;

      // Avoid Walls
      if (s.x < 150) { s.targetAngle = 0; danger = true; }
      else if (s.x > WORLD_SIZE - 150) { s.targetAngle = Math.PI; danger = true; }
      else if (s.y < 150) { s.targetAngle = Math.PI / 2; danger = true; }
      else if (s.y > WORLD_SIZE - 150) { s.targetAngle = -Math.PI / 2; danger = true; }

      // Avoid/Attack other snakes
      if (!danger) {
        for (let other of snakeList) {
          if (other.id === s.id || other.dead) continue;
          let dist = Math.hypot(s.x - other.x, s.y - other.y);
          if (dist < 180) { // Threat detected
            s.targetAngle = Math.atan2(s.y - other.y, s.x - other.x); // Flee in opposite direction
            s.isBoosting = true; // Use boost to escape or cut off
            danger = true;
            break;
          }
        }
      }

      // Hunt Food
      if (!danger) {
        let closestFood = null, minDist = 400;
        for (let f of foods) {
          let dist = Math.hypot(s.x - f.x, s.y - f.y);
          if (dist < minDist) { minDist = dist; closestFood = f; }
        }
        if (closestFood) {
          s.targetAngle = Math.atan2(closestFood.y - s.y, closestFood.x - s.x);
        }
      }
    }

    s.x += Math.cos(s.angle) * speed;
    s.y += Math.sin(s.angle) * speed;

    // Bounds kill
    if (s.x < 0 || s.x > WORLD_SIZE || s.y < 0 || s.y > WORLD_SIZE) return killSnake(s);

    s.body.unshift({ x: s.x, y: s.y });
    while (s.body.length > Math.floor(s.score * 2.5)) s.body.pop();

    // Eat Food
    foods.forEach((f, idx) => {
      if (Math.hypot(s.x - f.x, s.y - f.y) < 14 + f.size) {
        s.score += 1;
        foods[idx] = { id: Math.random().toString(), x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE, color: SKINS[Math.floor(Math.random() * SKINS.length)], size: Math.random() * 3 + 3 };
      }
    });

    // PvP Collisions
    for (let other of snakeList) {
      if (other.id === s.id || other.dead) continue;
      for (let i = 4; i < other.body.length; i += 2) {
        if (Math.hypot(s.x - other.body[i].x, s.y - other.body[i].y) < 16) {
          killSnake(s);
          return;
        }
      }
    }
  });

  io.emit('gameState', { snakes, foods });
}, 1000 / 40);

function killSnake(s) {
  s.dead = true;
  for (let i = 0; i < s.body.length; i += 3) {
    foods.push({ id: Math.random().toString(), x: s.body[i].x + (Math.random() - 0.5) * 25, y: s.body[i].y + (Math.random() - 0.5) * 25, color: s.color, size: 7 });
  }
  setTimeout(() => delete snakes[s.id], 100);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pro Server running on port ${PORT}`));
