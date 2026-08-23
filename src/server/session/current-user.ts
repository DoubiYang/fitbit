export type CurrentUser = {
  id: string;
  mode: 'demo';
};

export async function getCurrentUser(): Promise<CurrentUser> {
  return { id: 'demo_user', mode: 'demo' };
}
