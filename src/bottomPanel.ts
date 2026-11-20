export type PaperTradingPanelAction =
  | 'open-trades'
  | 'trade-history'
  | 'activity-console'
  | 'buy'
  | 'sell';

export function initializeBottomPanel(options: {
  mt5Enabled: boolean;
  alpacaEnabled: boolean;
  ibkrEnabled: boolean;
  ctraderEnabled: boolean;
  saxoEnabled: boolean;
  onPaperTradingAction(action: PaperTradingPanelAction): Promise<void>;
  onChartLiveTrade(side: 'buy' | 'sell'): Promise<void>;
}): void {
  const route = (buttonId: string, eventName: string): void => {
    document.getElementById(buttonId)?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent(eventName));
    });
  };

  route('editor-toggle-btn', 'omega:bottom-panel:editor-toggle');
  route('broker-toggle', 'omega:bottom-panel:broker-toggle');
  for (const action of ['open-trades', 'trade-history', 'activity-console'] as const) {
    document.getElementById(`${action === 'open-trades' ? 'open-trades' : action}-toggle`)
      ?.addEventListener('click', () => {
        void options.onPaperTradingAction(action).catch(error => {
          console.error(`Could not open ${action.replace('-', ' ')}:`, error);
        });
      });
  }
  for (const [buttonId, side] of [
    ['paper-trade-buy', 'buy'],
    ['paper-trade-sell', 'sell'],
  ] as const) {
    document.getElementById(buttonId)?.addEventListener('click', () => {
      void options.onChartLiveTrade(side).catch(error => {
        console.error(`Could not start the ${side} chart trade preview:`, error);
      });
    });
  }

  const localFeedsModal = document.getElementById('local-feeds-modal');
  const closeLocalFeeds = (): void => {
    localFeedsModal?.setAttribute('aria-hidden', 'true');
    if (localFeedsModal) localFeedsModal.hidden = true;
  };
  let lastSelectedFeedButton: HTMLButtonElement | null = null;
  const showLocalFeeds = (): void => {
    if (!localFeedsModal) return;
    localFeedsModal.hidden = false;
    localFeedsModal.setAttribute('aria-hidden', 'false');
    lastSelectedFeedButton?.focus();
  };

  document.getElementById('local-feeds-toggle')?.addEventListener('click', showLocalFeeds);
  document.getElementById('local-feeds-close')?.addEventListener('click', closeLocalFeeds);
  localFeedsModal?.addEventListener('click', event => {
    if (event.target === localFeedsModal) closeLocalFeeds();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-feed-back]').forEach(button => {
    button.addEventListener('click', () => {
      const panel = document.getElementById(button.dataset.feedBack ?? '');
      if (!panel) return;
      panel.hidden = true;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      showLocalFeeds();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-local-feed]').forEach(button => {
    const feed = button.dataset.localFeed ?? '';
    const route = ({
      mt5: { trigger: 'mt5-feed-toggle', modal: 'mt5-feed-modal' },
      alpaca: { trigger: 'broker-toggle', modal: 'broker-modal' },
      ibkr: { trigger: 'ibkr-feed-toggle', modal: 'ibkr-feed-modal' },
      quantower: { trigger: 'quantower-feed-toggle', modal: 'quantower-feed-modal' },
      ctrader: { trigger: 'ctrader-feed-toggle', modal: 'ctrader-feed-modal' },
      saxo: { trigger: 'saxo-feed-toggle', modal: 'saxo-feed-modal' },
    } as Record<string, { trigger: string; modal: string }>)[feed];
    const trigger = route ? document.getElementById(route.trigger) as HTMLButtonElement | null : null;
    const providerModal = route ? document.getElementById(route.modal) : null;
    const enabled = feed === 'mt5' ? options.mt5Enabled
      : feed === 'alpaca' ? options.alpacaEnabled
        : feed === 'ibkr' ? options.ibkrEnabled
          : feed === 'ctrader' ? options.ctraderEnabled
            : feed === 'saxo' ? options.saxoEnabled
              : feed === 'quantower';
    if (!trigger || !providerModal || !enabled) button.hidden = true;
    button.addEventListener('click', () => {
      if (!trigger || !providerModal || !enabled) return;
      lastSelectedFeedButton = button;
      trigger?.click();
      providerModal.hidden = false;
      providerModal.classList.add('open');
      providerModal.setAttribute('aria-hidden', 'false');
      closeLocalFeeds();
    });
  });

  document.getElementById('diagnostics-console-toggle')?.addEventListener('click', () => {
    void window.velaDiagnostics?.openConsole().catch(error => {
      console.error('Could not open the diagnostic console:', error);
    });
  });
}
