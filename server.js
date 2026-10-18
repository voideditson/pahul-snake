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

// Spawn initial shared food grid
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
  const body = [];
  const score = 10;

  for (let i = 0; i < score; i++) {
    body.push({ x: x - i * 6, y });
  }

  return {
    id,
    name,
    color,
    isBot,
    x,
    y,
    angle: Math.random() * Math.PI * 2,
    score,
    body,
    isBoosting: false,
    dead: false
  };
}

function maintainBotCount() {
  const activeSnakes = Object.values(snakes).filter(s => !s.dead);
  if (activeSnakes.length < TOTAL_SNAKES) {
    const botId = 'bot_' + Math.random().toString(36).substring(2, 7);
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + '_' + Math.floor(Math.random() * 99);
    const color = SKINS[Math.floor(Math.random() * SKINS.length)];
    snakes[botId] = createSnake(botId, name, color, true);
  }
}

// Socket Connection Management
io.on('connection', (socket) => {
  socket.on('joinGame', ({ username, skin }) => {
    snakes[socket.id] = createSnake(socket.id, username || 'Player', skin || '#38BDF8', false);
    socket.emit('init', { id: socket.id, worldSize: WORLD_SIZE });
  });

  socket.on('playerInput', ({ angle, isBoosting }) => {
    if (snakes[socket.id] && !snakes[socket.id].dead) {
      snakes[socket.id].angle = angle;
      snakes[socket.id].isBoosting = isBoosting;
    }
  });

  socket.on('disconnect', () => {
    delete snakes[socket.id];
  });
});

// Server Game Loop running at 30 Ticks/sec
setInterval(() => {
  maintainBotCount();

  const snakeList = Object.values(snakes);

  snakeList.forEach((s) => {
    if (s.dead) return;

    let speed = s.isBoosting && s.score > 5 ? 7 : 3.5;
    if (s.isBoosting && s.score > 5) {
      s.score -= 0.05;
    }

    // AI logic for bots
    if (s.isBot) {
      if (Math.random() < 0.03) s.angle += (Math.random() - 0.5) * 1.5;
      if (s.x < 100 || s.x > WORLD_SIZE - 100 || s.y < 100 || s.y > WORLD_SIZE - 100) {
        s.angle = Math.atan2(WORLD_SIZE / 2 - s.y, WORLD_SIZE / 2 - s.x);
      }
    }

    s.x += Math.cos(s.angle) * speed;
    s.y += Math.sin(s.angle) * speed;

    // Boundary check
    if (s.x < 0 || s.x > WORLD_SIZE || s.y < 0 || s.y > WORLD_SIZE) {
      killSnake(s);
      return;
    }

    // Body follow update
    s.body.unshift({ x: s.x, y: s.y });
    while (s.body.length > Math.floor(s.score * 2.5)) {
      s.body.pop();
    }

    // Eat Food Check
    foods.forEach((f, idx) => {
      if (Math.hypot(s.x - f.x, s.y - f.y) < 12 + f.size) {
        s.score += 0.8;
        foods[idx] = {
          id: Math.random().toString(36).substring(2, 7),
          x: Math.random() * WORLD_SIZE,
          y: Math.random() * WORLD_SIZE,
          color: SKINS[Math.floor(Math.random() * SKINS.length)],
          size: Math.random() * 3 + 3
        };
      }
    });

    // Check PvP collisions against other snakes
    snakeList.forEach((other) => {
      if (other.id === s.id || other.dead) return;
      for (let i = 4; i < other.body.length; i += 2) {
        const seg = other.body[i];
        if (Math.hypot(s.x - seg.x, s.y - seg.y) < 16) {
          killSnake(s);
          break;
        }
      }
    });
  });

  // Broadcast unified game state to all players
  io.emit('gameState', { snakes, foods });
}, 1000 / 30);

function killSnake(s) {
  s.dead = true;
  for (let i = 0; i < s.body.length; i += 3) {
    foods.push({
      id: Math.random().toString(36).substring(2, 7),
      x: s.body[i].x + (Math.random() - 0.5) * 20,
      y: s.body[i].y + (Math.random() - 0.5) * 20,
      color: s.color,
      size: 6
    });
  }
  setTimeout(() => {
    delete snakes[s.id];
  }, 100);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Snake Server running on port ${PORT}`));