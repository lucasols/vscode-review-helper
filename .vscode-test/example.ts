interface User {
  id: number
  name: string
  email: string
  avatar?: string
  bio?: string
  createdAt: Date
  lastLoginAt?: Date
  isActive: boolean
  permissions: string[]
  test?: string
  role: 'admin' | 'user' | 'viewer'
}

function greetUser(user: User): string {
  return `Hello, ${user.name}! You are logged in as ${user.role}.`
}

function filterByRole(
  users: User[],
  role: User['role'],
  options?: { includeInactive?: boolean },
): User[] {
  return users.filter(
    (u) => u.role === role && ((options?.includeInactive ?? false) || u.isActive),
  )
}

const sampleUsers: User[] = [
  {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    createdAt: new Date('2024-01-01'),
    isActive: true,
    permissions: ['read', 'write', 'delete'],
    role: 'admin',
  },
  {
    id: 2,
    name: 'Bob',
    email: 'bob@example.com',
    createdAt: new Date('2024-02-15'),
    isActive: true,
    permissions: ['read', 'write'],
    role: 'user',
  },
  {
    id: 3,
    name: 'Charlie',
    email: 'charlie@example.com',
    createdAt: new Date('2024-03-20'),
    isActive: false,
    permissions: ['read'],
    role: 'viewer',
  },
  {
    id: 4,
    name: 'Diana',
    email: 'diana@example.com',
    createdAt: new Date('2024-04-10'),
    isActive: true,
    permissions: ['read', 'write'],
    role: 'user',
  },
]

const admins = filterByRole(sampleUsers, 'admin')

console.log(admins.map(greetUser).join('\n'))
