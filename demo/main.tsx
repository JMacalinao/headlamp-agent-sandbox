import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { SandboxTerminal } from '../src/Terminal';
import { fakePod } from './fake-pod';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
    <CssBaseline />
    <SandboxTerminal pod={fakePod as any} container="agent" namespace="agents" />
  </ThemeProvider>
);

const fullscreen = new URLSearchParams(location.search).has('fullscreen');

// ?fullscreen opens the overlay the way the toolbar button does. demo/screenshot.mjs waits for
// window.demoReady, set once the chosen layout is up and the first tab has painted.
const poll = setInterval(() => {
  const open = document.querySelector<HTMLButtonElement>('[aria-label="Fullscreen"]');
  if (fullscreen && open) {
    open.click();
    return;
  }
  const painted = document.querySelector('.xterm-rows')?.textContent?.includes('npm test');
  if (painted && (!fullscreen || document.querySelector('[aria-label="Exit fullscreen"]'))) {
    clearInterval(poll);
    (window as any).demoReady = true;
  }
}, 100);
