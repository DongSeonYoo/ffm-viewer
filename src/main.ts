import { createApp } from './app-shell';
import { createTauriBridge } from './lib/tauri-bridge';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing.');

async function bootstrap(): Promise<void> {
  const fixture = new URLSearchParams(window.location.search).get('fixture');
  if (
    import.meta.env.DEV &&
    (fixture === 'markdown' || fixture === 'json' || fixture === 'json-large' || fixture === 'multi')
  ) {
    const { createBrowserPreviewBridge } = await import('./lib/browser-preview-bridge');
    await createApp(root!, createBrowserPreviewBridge(fixture));
    return;
  }

  await createApp(root!, createTauriBridge());
}

void bootstrap();
