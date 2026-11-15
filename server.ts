import express from 'express';
import path from 'node:path';
import { api, slackInteractions } from './server/routes';

const app = express();
app.set('trust proxy', true);

// Slack signs the raw request body, so this route must see it before any JSON parsing.
app.post('/api/slack/interactions', express.raw({ type: () => true, limit: '1mb' }), slackInteractions);

app.use(express.json({ limit: '2mb' }));
app.use('/api', api);

const PORT = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve('dist');
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => console.log(`IT order notifier listening on http://localhost:${PORT}`));
