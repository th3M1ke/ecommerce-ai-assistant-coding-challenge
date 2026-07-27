/**
 * Starting the service.
 *
 * Fails loudly and early: if the database has not been created or the provider
 * is not configured, that is clear at startup rather than on the first question.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolveDatabasePath } from '../database/connection.ts';
import { openAnalyticsDatabase } from '../analytics/execute.ts';
import { createProvider } from '../ai/create-provider.ts';
import { readProviderConfig } from '../ai/provider.ts';
import { createRequestListener } from './app.ts';

function main(): void {
  const port = Number(process.env.PORT ?? 3000);
  const databasePath = resolveDatabasePath();

  if (!existsSync(databasePath)) {
    console.error(`No database at ${databasePath}\nRun \`npm run db:create\` first.`);
    process.exit(1);
  }

  const config = readProviderConfig();
  const provider = createProvider(config);
  const db = openAnalyticsDatabase(databasePath);

  const server = createServer(createRequestListener({ db, provider }));

  server.listen(port, () => {
    console.log(`Analytics assistant listening on http://localhost:${port}`);
    console.log(`  database: ${databasePath} (read-only)`);
    console.log(`  model:    ${provider.name}/${provider.model}`);
    console.log('');
    console.log('Ask a question:');
    console.log(
      `  curl -s localhost:${port}/ask -H 'content-type: application/json' \\\n` +
        `    -d '{"question":"What is the average order value?","format":"text"}'`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (error) {
  console.error('Failed to start:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
