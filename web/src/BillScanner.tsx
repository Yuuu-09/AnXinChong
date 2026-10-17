import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, ImagePlus, ScanLine } from 'lucide-react';
import { decodeBillLink } from '@anxinchong/protocol/bill';
import { Modal, Notice } from './components';
import { manifest } from './lib/runtime';

async function readQr(source: CanvasImageSource, width: number, height: number) {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法读取图像，请粘贴账单链接。');
  // Dense bill codes can lose their module grid after video scaling. Try several
  // resolutions without smoothing rather than relying on one resampled frame.
  let previousWidth = 0;
  for (const limit of [1800, 900, 600, 320]) {
    const ratio = Math.min(1, limit / Math.max(width, height));
    const nextWidth = Math.max(1, Math.round(width * ratio));
    if (nextWidth === previousWidth) continue;
    previousWidth = nextWidth;
    canvas.width = nextWidth;
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (result) return result.data;
  }
}

export default function BillScanner({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  function stop() {
    generation.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  useEffect(() => {
    if (open) {
      setError('');
      setLink('');
      setCamera(false);
      setBusy(false);
    }
    return stop;
  }, [open]);
  function accept(value: string) {
    const bill = decodeBillLink(value, manifest.chainId);
    stop();
    setCamera(false);
    onClose();
    navigate(bill.route);
  }
  async function startCamera() {
    stop();
    const token = generation.current;
    setError('');
    setBusy(true);
    setCamera(false);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error('摄像头需要 HTTPS 或本机 localhost 环境，请识别图片或粘贴账单链接。');
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (generation.current !== token) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      video.current!.srcObject = media;
      await video.current!.play();
      if (generation.current !== token) return;
      setCamera(true);
      setBusy(false);
      async function scan() {
        if (generation.current !== token) return;
        try {
          const element = video.current;
          if (element && element.readyState >= 2 && element.videoWidth) {
            const value = await readQr(element, element.videoWidth, element.videoHeight);
            if (generation.current !== token) return;
            if (value) {
              accept(value);
              return;
            }
          }
        } catch (e) {
          if (generation.current !== token) return;
          setError(e instanceof Error ? e.message : '识别失败，请重试。');
        }
        if (generation.current === token) timer.current = setTimeout(() => void scan(), 300);
      }
      void scan();
    } catch (e) {
      if (generation.current !== token) return;
      stop();
      setCamera(false);
      setBusy(false);
      setError(
        e instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(e.name)
          ? '摄像头未获授权，请允许相机权限后重试，也可以识别图片或粘贴链接。'
          : e instanceof DOMException && e.name === 'NotFoundError'
            ? '未找到摄像头，请识别图片或粘贴链接。'
            : e instanceof Error
              ? e.message
              : '无法开启摄像头，请重试。',
      );
    }
  }
  async function scanFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    stop();
    setCamera(false);
    setError('');
    setBusy(true);
    const token = generation.current;
    let imageUrl: string | undefined;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('请选择 15 MB 以内的二维码图片。');
      imageUrl = URL.createObjectURL(file);
      const picture = new Image();
      picture.src = imageUrl;
      await picture.decode();
      if (picture.naturalWidth * picture.naturalHeight > 50_000_000)
        throw new Error('图片尺寸过大，请裁剪二维码区域后重试。');
      const value = await readQr(picture, picture.naturalWidth, picture.naturalHeight);
      if (generation.current !== token) return;
      if (!value) throw new Error('未识别到二维码，请使用清晰图片或让商家放大二维码。');
      accept(value);
    } catch (e) {
      if (generation.current === token)
        setError(e instanceof Error ? e.message : '图片识别失败，请重试。');
    } finally {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (generation.current === token) setBusy(false);
    }
  }
  function paste(event: FormEvent) {
    event.preventDefault();
    try {
      accept(link);
    } catch (e) {
      setError(e instanceof Error ? e.message : '账单链接无效');
    }
  }
  return (
    <Modal title="扫码消费" open={open} onClose={onClose}>
      <p className="muted modal-description">扫描商家出示的账单二维码，核对消费后再签名确认。</p>
      <div className={`scanner-view ${camera ? 'is-active' : ''}`}>
        <video ref={video} playsInline muted aria-label="扫码摄像头" />
        {!camera && (
          <div className="scanner-placeholder">
            <ScanLine size={48} />
            <strong>{busy ? '正在准备识别…' : '将账单二维码放入取景框'}</strong>
            <span>支持后置摄像头与二维码图片</span>
          </div>
        )}
        <div className="scanner-guide" aria-hidden="true" />
      </div>
      <div className="row-actions scanner-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => (camera ? (stop(), setCamera(false)) : void startCamera())}
        >
          <Camera size={17} />
          {camera ? '关闭摄像头' : '开启摄像头'}
        </button>
        <label className={`secondary file-button ${busy ? 'is-disabled' : ''}`}>
          <ImagePlus size={17} />
          识别二维码图片
          <input
            type="file"
            accept="image/*"
            aria-label="识别二维码图片"
            disabled={busy}
            onChange={(event) => void scanFile(event)}
          />
        </label>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <details className="bill-link-details">
        <summary>也可以粘贴账单链接</summary>
        <form onSubmit={paste}>
          <label className="field">
            <span>账单链接</span>
            <textarea
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="粘贴商家分享的完整消费账单链接"
              required
            />
          </label>
          <button className="secondary" disabled={!link.trim() || busy}>
            进入消费确认
          </button>
        </form>
      </details>
      <p className="scanner-note">
        图像仅在当前设备识别。关闭弹窗后摄像头自动停止，扫码不会自动签名或扣款。
      </p>
    </Modal>
  );
}
