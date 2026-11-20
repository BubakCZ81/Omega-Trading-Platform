import { registerSidePanel, type SidePanelHandle } from './platform';
import rightTradingPaneMarkup from './rightTradingPane.html?raw';

registerSidePanel({
  id: 'omega-trading-panel',
  title: 'Trading Panel',
  icon: 'omega-trading-panel',
  order: 10,
  width: 340,
  resizable: true,
  minWidth: 260,
  maxWidth: 520,
  overlay: false,
  header: 'none',
  mount(_context, body, header) {
    const template = document.createElement('template');
    template.innerHTML = rightTradingPaneMarkup.trim();
    const pane = template.content.querySelector<HTMLElement>('#omega-trading-pane');
    if (!pane) throw new Error('Trading Panel markup is missing its root element.');
    const close = pane.querySelector<HTMLButtonElement>('#trading-pane-close');
    if (!close) throw new Error('Trading Panel markup is missing its close control.');

    pane.setAttribute('aria-hidden', 'false');
    body.replaceChildren(pane);
    const closePanel = () => header.close();
    close.addEventListener('click', closePanel);
    document.dispatchEvent(new CustomEvent('omega:trading-panel-mounted'));

    return {
      onOpen() {
        pane.setAttribute('aria-hidden', 'false');
        document.dispatchEvent(new CustomEvent('omega:trading-panel-open'));
      },
      destroy() {
        close.removeEventListener('click', closePanel);
        pane.remove();
        document.dispatchEvent(new CustomEvent('omega:trading-panel-unmounted'));
      },
    } satisfies SidePanelHandle;
  },
});
