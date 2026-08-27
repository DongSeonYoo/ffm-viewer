import { createApp } from './app-shell';
import { createTauriBridge } from './lib/tauri-bridge';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing.');

async function bootstrap(): Promise<void> {
  const fixture = new URLSearchParams(window.location.search).get('fixture');
  if (
    import.meta.env.DEV &&
    ['markdown', 'json', 'json-large', 'text', 'yaml', 'toml', 'image', 'multi']
      .includes(fixture ?? '')
  ) {
    const { createBrowserPreviewBridge } = await import('./lib/browser-preview-bridge');
    await createApp(
      root!,
      createBrowserPreviewBridge(
        fixture as Parameters<typeof createBrowserPreviewBridge>[0],
      ),
    );
    return;
  }

  await createApp(root!, createTauriBridge());
}

void bootstrap();
