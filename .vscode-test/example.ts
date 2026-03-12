interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'user' | 'viewer'
}

function greetUser(user: User): string {
  return `Hello, ${user.name}! You are logged in as ${user.role}.`
}

function filterByRole(users: User[], role: User['role']): User[] {
  return users.filter((u) => u.role === role)
}

const sampleUsers: User[] = [
  { id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: 2, name: 'Bob', email: 'bob@example.com', role: 'user' },
  { id: 3, name: 'Charlie', email: 'charlie@example.com', role: 'viewer' },
  { id: 4, name: 'Diana', email: 'diana@example.com', role: 'user' },
]

const admins = filterByRole(sampleUsers, 'admin')
console.log(admins.map(greetUser).join('\n'))
