import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';
import { fileURLToPath } from 'node:url';
import { devTrafficFixture } from './tools/dev-traffic-fixture.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../', import.meta.url)), 'VITE_');
  return {
  plugins: [devTrafficFixture()],
  base: process.env.VITE_SPACE_BASE_PATH || env.VITE_SPACE_BASE_PATH || '/space/app/',
  envDir: '..',
  resolve: {
    // The linked engine has its own test dependencies; the browser uses one Three instance.
    dedupe: ['three'],
  },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        fileURLToPath(new URL('../engine', import.meta.url)),
      ],
    },
  },
  build: {
    // Three's minified ESM core is about 600 kB by itself. Application chunks
    // remain below this vendor-aware ceiling and are split by change cadence.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        // Three.js changes independently from most application code. Keeping it
        // in a stable vendor chunk improves repeat-visit and deployment caching
        // while keeping the main application chunk within a reviewable budget.
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/react-icons/')) return 'ui-icons';
          if (id.includes('/node_modules/react/')
            || id.includes('/node_modules/react-dom/')
            || id.includes('/node_modules/scheduler/')) return 'react';
          if (id.includes('/node_modules/@bufbuild/protobuf/')) return 'protobuf';
          if (id.includes('/node_modules/@msgpack/msgpack/')) return 'realtime-codec';
          if (id.includes('/node_modules/acorn/')) return 'script-runtime';
          if (/\/bootstrap\/(NetworkSafety|NetworkTraffic|UploadProgress)\.ts$/.test(id)) return 'network-core';
          if (id.endsWith('/engine/contraption/AgentConfig.ts')) return 'agent-config';
          if (id.endsWith('/engine/contraption/AgentChat.ts')
            || id.endsWith('/engine/contraption/BehaviorAgent.ts')) return 'agent';
          if (id.endsWith('/engine/contraption/Blueprints.ts')) return 'blueprints';
          if (id.includes('/components/monitoring/')) return 'admin-monitoring';
          if (id.includes('/entropydrop_space/engine/src/scripting/')) return 'script-runtime';
          if (/\/entropydrop_space\/engine\/src\/(physics|contraption|simulation|actions|voxel|torus|worldgen|mesher|render)\//.test(id)) return 'world-simulation';
          if (id.includes('/client/src/engine/physics/')
            || id.includes('/client/src/engine/contraption/')
            || id.includes('/client/src/engine/simulation/')
            || id.includes('/client/src/engine/actions/')
            || id.includes('/client/src/engine/voxel/')
            || id.includes('/client/src/engine/torus/')
            || id.includes('/client/src/engine/worldgen/')
            || id.includes('/client/src/engine/mesher/')
            || id.includes('/client/src/engine/render/')
            || id.includes('/client/src/engine/audio/')) return 'world-simulation';
        }
      }
    }
  },
  optimizeDeps: {
    // The QuickJS variant resolves its WASM relative to its own module. Vite's
    // dependency pre-bundler can strand that URL inside .vite/deps in workers.
    exclude: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync']
  },
  worker: {
    format: 'es'
  }
};
});
