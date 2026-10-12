import ReactDOM from 'react-dom/client';
import App from './App';
import Overlay from './Overlay';
import FloatingChat from './FloatingChat';
import './styles.css';

const companion = new URLSearchParams(window.location.search).get('window') === 'companion';
ReactDOM.createRoot(document.getElementById('root')!).render(companion ? <Overlay /> : new URLSearchParams(window.location.search).get('window') === 'chat' ? <FloatingChat /> : <App />);
