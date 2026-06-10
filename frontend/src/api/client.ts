export class APIError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string,
  ) {
    super(message)
    this.name = 'APIError'
  }
}

export async function apiCall<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  const data = await response.json()

  if (!response.ok) {
    throw new APIError(
      response.status,
      JSON.stringify(data),
      data.error || `API error: ${response.status}`,
    )
  }

  return data as T
}
