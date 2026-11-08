// The categories and priorities the app needs to work (tickets must have one of each).
// Shared by scripts/seed.js and tests/globalSetup.js, so the demo data and the test database use the same list.

// [name, description]
const categories = [
  ['Hardware', 'Laptops, desktops, monitors, printers and other devices'],
  ['Software', 'Installing, updating or fixing applications'],
  ['Network', 'Wi-Fi, cabling, internet and network outages'],
  ['Access', 'Accounts, passwords, VPN and permissions'],
  ['Email', 'Mailboxes, Outlook, calendars and suspicious emails'],
  ['Other', 'Anything that does not fit another category'],
];

// [name, level, target_hours]
const priorities = [
  ['Low', 1, 120],
  ['Medium', 2, 72],
  ['High', 3, 24],
  ['Critical', 4, 4],
];

module.exports = { categories, priorities };
