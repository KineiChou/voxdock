export interface ConsoleAccount {
  username: string;
  revision: number;
  allow_remote_management: boolean;
}
export interface ConsoleAccountUpdate extends ConsoleAccount {
  current_password: string;
  new_password?: string;
}
export interface ConsoleAccountUpdateResult {
  account: ConsoleAccount;
  login_required: boolean;
}
