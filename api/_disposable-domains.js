// /api/_disposable-domains.js
// List of common disposable/temporary email domains to block.
// Source: curated from popular temp-mail services. Easy to extend.

export const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamailblock.com',
  'mailinator.com', 'mailinator.net', 'mailinator.org',
  'temp-mail.org', 'temp-mail.io', 'tempmail.com', 'tempmail.net', 'tempmailo.com',
  'throwawaymail.com', 'throwaway.email',
  'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'mailtemp.info',
  'yopmail.com', 'yopmail.net', 'yopmail.fr',
  'getairmail.com', 'getnada.com', 'nada.email',
  'fakeinbox.com', 'mytrashmail.com', 'trashmail.com', 'trashmail.net',
  'tempinbox.com', 'tempr.email', 'tempmail.de',
  'mohmal.com', 'mohmal.in.net',
  'sharklasers.com', 'spam4.me', 'pokemail.net',
  'inboxbear.com', 'inboxalias.com',
  'discard.email', 'dispostable.com',
  'mailsac.com', 'inboxkitten.com',
  'emaildrop.io', 'mintemail.com',
  'mvrht.com', 'mvrht.net',
  'tutamail.com', // sometimes flagged but is legitimate — DO NOT include
  'protonmail.com', // legit — DO NOT include
  // Add more as you spot abuse patterns
]);

// Remove the legit ones that snuck in (defensive)
DISPOSABLE_DOMAINS.delete('tutamail.com');
DISPOSABLE_DOMAINS.delete('protonmail.com');

export function isDisposableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return false;
  return DISPOSABLE_DOMAINS.has(domain);
}
