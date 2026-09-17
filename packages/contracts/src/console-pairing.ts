export interface WhatsAppSetup {
  available: boolean;
  linked: boolean;
  unlink_pending: boolean;
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

export interface TelegramPairingIdentity {
  user_id: string;
  display_name: string;
  username?: string;
  phone?: string;
}
export interface TelegramTargetPairing {
  id: string;
  method: 'message' | 'call';
  state: 'waiting' | 'candidate' | 'completed' | 'cancelled' | 'expired' | 'failed';
  expires_at: string;
  account: TelegramPairingIdentity;
  code?: string;
  candidate?: TelegramPairingIdentity & { id: string };
  error?: string;
}
export interface TelegramSetup {
  linked: boolean;
  credentials_ready: boolean;
  pairing_available: boolean;
  target: { user_id: string; enabled: boolean } | null;
}
