import { MobileMealEditor } from '../../../src/ui/meals/mobile-meal-editor';
import styles from '../../../src/ui/meals/meal-editor.module.css';

export const dynamic = 'force-dynamic';

export default async function MealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className={styles.page}><MobileMealEditor initialMealId={id} /></div>;
}
