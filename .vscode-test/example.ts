interface User {
  id: number
  name: string
  email: string
  avatar?: string
  bio?: string
  createdAt: Date
  lastLoginAt?: Date
  isActive: boolean
  department?: 'engineering' | 'design' | 'support'
  location?: string
  timezoneOffsetMinutes?: number
  favoriteTool?: string
  preferredLanguage?: 'en' | 'pt-BR' | 'es'
  team?: string
  permissions: string[]
  role: 'admin' | 'user' | 'viewer'
}

function greetUser(user: User): string {
  const statusLabel = user.isActive ? 'active' : 'inactive'
  const permissionSummary = `${user.permissions.length} permission(s)`
  const locationLabel = user.location ?? 'unknown location'
  const toolLabel = user.favoriteTool ?? 'no preferred tool'
  return `Hello, ${user.name}! You are logged in as ${user.role}, currently ${statusLabel}, based in ${locationLabel}, using ${toolLabel}, with ${permissionSummary}.`
}

function filterByRole(
  users: User[],
  role: User['role'],
  options?: {
    includeInactive?: boolean
    requiredPermission?: string
    sortByName?: boolean
    department?: User['department']
  },
): User[] {
  const filteredUsers = users.filter(
    (u) =>
      u.role === role
      && ((options?.includeInactive ?? false) || u.isActive)
      && (!options?.requiredPermission || u.permissions.includes(options.requiredPermission))
      && (!options?.department || u.department === options.department)
  )

  if (!options?.sortByName) {
    return filteredUsers
  }

  return [...filteredUsers].sort((left, right) => left.name.localeCompare(right.name))
}

function summarizeUsers(users: User[]): string[] {
  return users.map(
    (user) =>
      `${user.name} | ${user.role} | ${user.department ?? 'unassigned'} | ${user.location ?? 'remote'} | ${user.team ?? 'general'}`,
  )
}

function countUsersByDepartment(users: User[]): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const user of users) {
    const key = user.department ?? 'unassigned'
    counts[key] = (counts[key] ?? 0) + 1
  }

  return counts
}

function getRecentlyActiveUsers(users: User[]): User[] {
  return users.filter((user) => user.lastLoginAt !== undefined)
}

const sampleUsers: User[] = [
  {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    avatar: 'https://example.com/alice.png',
    bio: 'Owns release coordination and architecture reviews.',
    createdAt: new Date('2024-01-01'),
    lastLoginAt: new Date('2024-05-01T09:30:00Z'),
    isActive: true,
    department: 'engineering',
    location: 'Sao Paulo',
    preferredLanguage: 'pt-BR',
    team: 'platform',
    permissions: ['read', 'write', 'delete'],
    role: 'admin',
  },
  {
    id: 2,
    name: 'Bob',
    email: 'bob@example.com',
    createdAt: new Date('2024-02-15'),
    isActive: true,
    department: 'design',
    location: 'Lisbon',
    timezoneOffsetMinutes: 0,
    favoriteTool: 'Figma',
    preferredLanguage: 'en',
    team: 'brand',
    permissions: ['read', 'write'],
    role: 'user',
  },
  {
    id: 3,
    name: 'Charlie',
    email: 'charlie@example.com',
    createdAt: new Date('2024-03-20'),
    isActive: false,
    department: 'support',
    location: 'Curitiba',
    favoriteTool: 'Zendesk',
    preferredLanguage: 'pt-BR',
    team: 'triage',
    permissions: ['read'],
    role: 'viewer',
  },
  {
    id: 4,
    name: 'Diana',
    email: 'diana@example.com',
    createdAt: new Date('2024-04-10'),
    isActive: true,
    lastLoginAt: new Date('2024-05-04T14:15:00Z'),
    department: 'engineering',
    location: 'Recife',
    timezoneOffsetMinutes: -180,
    favoriteTool: 'VS Code',
    preferredLanguage: 'pt-BR',
    team: 'release',
    permissions: ['read', 'write', 'deploy'],
    role: 'user',
  },
  {
    id: 5,
    name: 'Eve',
    email: 'eve@example.com',
    createdAt: new Date('2024-05-05'),
    isActive: true,
    department: 'support',
    location: 'Porto',
    favoriteTool: 'Linear',
    preferredLanguage: 'en',
    team: 'customer-success',
    permissions: ['read', 'triage'],
    role: 'viewer',
  },
  {
    id: 6,
    name: 'Frank',
    email: 'frank@example.com',
    createdAt: new Date('2024-05-12'),
    isActive: true,
    department: 'design',
    location: 'Madrid',
    timezoneOffsetMinutes: 60,
    favoriteTool: 'FigJam',
    preferredLanguage: 'es',
    team: 'product-marketing',
    permissions: ['read', 'write', 'comment'],
    role: 'user',
  },
  {
    id: 7,
    name: 'Grace',
    email: 'grace@example.com',
    createdAt: new Date('2024-05-20'),
    lastLoginAt: new Date('2024-05-21T08:00:00Z'),
    isActive: true,
    department: 'engineering',
    location: 'Campinas',
    timezoneOffsetMinutes: -180,
    favoriteTool: 'Terminal',
    preferredLanguage: 'en',
    team: 'developer-experience',
    permissions: ['read', 'write', 'review'],
    role: 'user',
  },
]

const admins = filterByRole(sampleUsers, 'admin', {
  requiredPermission: 'delete',
  sortByName: true,
})
const activeViewers = filterByRole(sampleUsers, 'viewer', {
  includeInactive: true,
  sortByName: true,
})
const designers = filterByRole(sampleUsers, 'user', {
  requiredPermission: 'write',
  sortByName: true,
  department: 'design',
})
const userSummary = summarizeUsers(sampleUsers)
const departmentCounts = countUsersByDepartment(sampleUsers)
const recentUsers = getRecentlyActiveUsers(sampleUsers)

console.log(admins.map(greetUser).join('\n'))
console.log(activeViewers.map(greetUser).join('\n'))
console.log(designers.map(greetUser).join('\n'))
console.log(recentUsers.map((user) => user.name).join(', '))
console.log(userSummary.join('\n'))
console.log(JSON.stringify(departmentCounts, null, 2))
