/**
 * Centralized White-Label Branding Configuration
 *
 * Configures customer-facing brand identity across checkout-portal,
 * payment-api, and banking observers.
 */
export const BRANDING_CONFIG = Object.freeze({
  businessName: 'NeuroSky Pay',
  poweredBy: 'NeuroSky Pay',
  appName: 'NeuroSky Pay',
  supportEmail: 'support@neurosky.local',
  supportEmails: Object.freeze(['support@neurosky.local']),
  supportPhone: '9876543210',
  supportMobiles: Object.freeze(['9876543210']),
  logoUrl: '',
  primaryColor: '#2563eb',
  sidebarNotice: 'Fast & Secure 256-Bit Bank Encryption',
  trustBadgeText: 'Verified Business · Powered by NeuroSky Pay',
  counterInstructions: 'Please visit the billing counter and present this screen to the cashier.',
  cardCounterInstructions: 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
});
