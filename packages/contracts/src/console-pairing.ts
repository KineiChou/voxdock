export interface WhatsAppSetup {
  available: boolean;
  connected: boolean;
  account_phone: string | null;
  target: { phone: string; enabled: boolean } | null;
  pairing_available: boolean;
}

export interface TargetPairing {
  id: string;
  method: 'message' | 'call';
  state: 'waiting' | 'candidate' | 'completed' | 'cancelled' | 'expired' | 'failed';
  expires_at: string;
  account_phone: string;
  code?: string;
  candidate?: { id: string; phone: string };
  error?: string;
}
