export const dynamic = 'force-dynamic';

export async function POST(_request: Request, _context: { params: Promise<{ id: string }> }): Promise<Response> {
  return Response.json({ error: 'meal_confirm_replaced' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
