import './styles/app.css';
import { EarthquakeApp } from './ui/App';

const root = document.getElementById('root');
if (root) {
  new EarthquakeApp(root, import.meta.env.BASE_URL);
}
