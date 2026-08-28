import { MobileMealEditor } from '../../../src/ui/meals/mobile-meal-editor';
import styles from '../../../src/ui/meals/meal-editor.module.css';

export const dynamic = 'force-dynamic';

export default function NewMealPage() {
  return <div className={styles.page}><MobileMealEditor /></div>;
}
