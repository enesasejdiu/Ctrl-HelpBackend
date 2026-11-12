// The categories and priorities the app needs to work (tickets must have one of each), in the order lists show them.
// Migration 015 inserts the same lists into an empty database (tests/migrations.test.js checks they match), and
// scripts/seed.js puts them back after wiping the demo data.

// [name, description]
const categories = [
  ['Hardware', 'Laptops, desktops, monitors, printers and other devices'],
  ['Software', 'Installing, updating or fixing applications'],
  ['Network', 'Wi-Fi, cabling, internet and network outages'],
  ['Access', 'Accounts, passwords, VPN and permissions'],
  ['Email', 'Mailboxes, Outlook, calendars and suspicious emails'],
  ['Other', 'Anything that does not fit another category'],
]

// [name, level, target_hours]
const priorities = [
  ['Low', 1, 120],
  ['Medium', 2, 72],
  ['High', 3, 24],
  ['Critical', 4, 4],
]

// The priority a new ticket gets when none is chosen
const defaultPriority = 'Medium'

module.exports = { categories, priorities, defaultPriority }
