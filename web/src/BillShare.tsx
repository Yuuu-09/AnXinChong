import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowRight, Copy, Maximize2, ScanLine, ShieldCheck, X } from 'lucide-react';
import { decodeBillLink } from '@anxinchong/protocol/bill';
import { Amount, Modal, Notice } from './components';
import { manifest } from './lib/runtime';

export default function BillShare({ link, onClose }: { link: string; onClose: () => void }) {
  const [enlarged, setEnlarged] = useState(false);
  const [copied, setCopied] = useState('');
  let bill;
  try {
    bill = decodeBillLink(link, manifest.chainId).envelope;
  } catch {
    return <Notice tone="danger">保存的账单无法解析，请重新生成消费账单。</Notice>;
  }
  const qrAvailable = new TextEncoder().encode(link).length <= 2500;
  return (
    <div className="bill-output">
      <button
        type="button"
        className="bill-dismiss"
        aria-label="关闭账单展示"
        title="关闭展示，不撤销已签名账单"
        onClick={onClose}
      >
        <X size={17} />
        关闭
      </button>
      <div className="bill-qr-card">
        <div className="bill-qr-label">
          <ScanLine size={16} />
          消费确认码
        </div>
        {qrAvailable ? (
          <>
            <button
              className="bill-qr-frame"
              aria-label="放大账单二维码"
              onClick={() => setEnlarged(true)}
            >
              <QRCodeSVG
                value={link}
                size={320}
                level="L"
                boostLevel={false}
                marginSize={4}
                role="img"
                aria-label="消费账单二维码"
              />
            </button>
            <button className="text-button bill-qr-enlarge" onClick={() => setEnlarged(true)}>
              <Maximize2 size={14} />
              放大二维码
            </button>
          </>
        ) : (
          <Notice>账单较长，请复制链接发送给消费者。</Notice>
        )}
        <p>
          消费者打开“我的会员卡”
          <br />
          点击“扫码消费”进行确认
        </p>
      </div>
      <div className="bill-share-details">
        <span className="tag">
          <ShieldCheck size={13} />
          商家已签名
        </span>
        <h3>{bill.serviceText}</h3>
        <p className="muted">请消费者扫码核对本次消费，并在钱包中签名确认。</p>
        <div className="bill-share-summary">
          <div>
            <span>本次本金扣除</span>
            <strong>
              <Amount value={bill.bill.debitAmount} />
            </strong>
          </div>
          <div>
            <span>会员账户</span>
            <strong>#{bill.bill.membershipId.toString()}</strong>
          </div>
          <div>
            <span>{bill.bill.mode === 1 ? '本次使用' : '消费实付比例'}</span>
            <strong>
              {bill.bill.mode === 1
                ? `${bill.bill.units} 次`
                : `${Number(bill.bill.discountBps) / 100}%`}
            </strong>
          </div>
          <div>
            <span>确认截止时间</span>
            <strong>
              {new Date(Number(bill.bill.deadline) * 1000).toLocaleTimeString('zh-CN', {
                hour12: false,
              })}
            </strong>
          </div>
        </div>
        <div className="row-actions">
          <button
            className="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(link)
                .then(() => setCopied('已复制'))
                .catch(() => setCopied('复制失败，请展开下方完整链接手动复制'))
            }
          >
            <Copy size={16} />
            {copied === '已复制' ? copied : '复制链接'}
          </button>
          <a className="text-link" href={link}>
            打开消费者确认页 <ArrowRight size={14} />
          </a>
        </div>
        {copied && (
          <p role="status" className="muted">
            {copied}
          </p>
        )}
        <details className="bill-link-details">
          <summary>查看完整账单链接</summary>
          <textarea aria-label="完整账单链接" readOnly value={link} />
        </details>
        <p className="bill-share-note">扫码与签名后，仍需链上结算成功才算收款。</p>
      </div>
      <Modal title="扫码确认本次消费" open={enlarged} onClose={() => setEnlarged(false)}>
        <div className="bill-qr-large">
          <QRCodeSVG
            value={link}
            size={560}
            level="L"
            boostLevel={false}
            marginSize={4}
            role="img"
            aria-label="放大的消费账单二维码"
          />
          <strong>{bill.serviceText}</strong>
          <p>请在“我的会员卡”中点击“扫码消费”</p>
        </div>
      </Modal>
    </div>
  );
}
