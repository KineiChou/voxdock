export interface ConnectionFlow {
  id: string;
  channel: 'telegram' | 'whatsapp';
  state: 'starting' | 'code_required' | 'password_required' | 'qr_required' | 'connected' | 'cancelled' | 'expired' | 'failed';
  expires_at: string;
  qr?: string;
  qr_expires_at?: string;
  error?: string;
}
