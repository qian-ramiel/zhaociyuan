import { useState } from 'react';
import { Eye, Maximize, Scan, ZoomIn } from 'lucide-react';
import type { Message, ScreenContext } from '../types';
import { IconButton, Modal } from './Ui';

export function ScreenAttachment({ metadata, preview }: { metadata: NonNullable<Message['screen_context']>; preview?: ScreenContext }) {
  const [open, setOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [dimensions, setDimensions] = useState('');
  const close = () => { setOpen(false); setActualSize(false); };
  return <>
    <button type="button" className="screen-attachment" disabled={!preview} title={preview ? '预览本次画面' : '画面未保留'} aria-label={`预览画面 ${metadata.sourceName}`} onClick={() => setOpen(true)}>
      <Eye size={13} /><span className="attachment-source">{metadata.sourceName}</span><span>{preview ? '本次画面' : '画面未保留'}</span>{preview && <Maximize size={13} />}
    </button>
    {open && preview && <Modal title="本次画面" onClose={close}>
      <div className="screen-preview-toolbar"><span>{preview.sourceName}</span><small>{dimensions}</small><IconButton title={actualSize ? '适应窗口' : '原始尺寸'} active={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? <Scan size={17} /> : <ZoomIn size={17} />}</IconButton></div>
      <div className={'screen-preview-image ' + (actualSize ? 'actual-size' : '')}><img src={preview.imageData} alt={`捕获画面 ${preview.sourceName}`} onLoad={(e) => setDimensions(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /></div>
    </Modal>}
  </>;
}
