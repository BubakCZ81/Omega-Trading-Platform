export type ChartAccountStatus = 'OFFLINE' | 'DEMO' | 'LIVE' | 'CONNECTED' | 'DATA ONLY';

export function getChartAccountStatus(accountId: string | null, mode: string | null): ChartAccountStatus {
  if (!accountId) return 'OFFLINE';
  if (accountId === 'local-demo') return 'DEMO';

  switch (mode?.trim().toLowerCase()) {
    case 'live':
    case 'real':
      return 'LIVE';
    case 'demo':
    case 'simulation':
    case 'paper':
      return 'DEMO';
    case 'data':
      return 'DATA ONLY';
    default:
      return 'CONNECTED';
  }
}

export function resolveChartOrderRoute(accountId: string | null, requestedRoute: 'paper' | 'live'): 'paper' | 'live' {
  return accountId === 'local-demo' ? 'paper' : requestedRoute;
}
