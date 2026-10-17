import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { zeroAddress, type Address } from 'viem';
import { registryAbi } from '../generated/abi';
import { configured, manifest, publicClient, readUserProfile, shortAddress } from '../lib/runtime';
import { useTransactions } from '../lib/transactions';
import { Empty, Loading, Notice, QueryError, Title, TxStatus } from '../components';

export function useProfile(account?: Address) {
  return useQuery({
    queryKey: [manifest.chainId, manifest.userRegistry, 'profile', account],
    enabled: configured && !!account,
    queryFn: () => readUserProfile(account!),
  });
}

export function UserLabel({ account }: { account: Address }) {
  const profile = useProfile(account);
  return (
    <span className="user-label" title={account}>
      {profile.data?.handle ? (
        <>
          {profile.data.nickname} <small>@{profile.data.handle}</small> · {shortAddress(account)}
        </>
      ) : (
        shortAddress(account)
      )}
    </span>
  );
}

export function BusinessGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { address } = useAccount();
  const profile = useProfile(address);
  if (!address || !configured) return children;
  if (profile.isPending) return <Loading />;
  if (profile.error)
    return <QueryError error={profile.error} retry={() => void profile.refetch()} />;
  if (!profile.data?.handle)
    return (
      <section className="panel">
        <h2>请先注册用户资料</h2>
        <p>设置永久 handle 和可修改的昵称后，即可购买会员卡、消费或注册商家。</p>
        <Link
          className="primary"
          to="/profile"
          state={{ from: location.pathname + location.search }}
        >
          去注册用户资料
        </Link>
      </section>
    );
  return children;
}

function ProfileEditor({ account, continueTo }: { account: Address; continueTo: string }) {
  const { chainId } = useAccount();
  const profile = useProfile(account);
  const tx = useTransactions();
  const [handle, setHandle] = useState('');
  const [nickname, setNickname] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const registered = !!profile.data?.handle;
  useEffect(() => setNickname(profile.data?.nickname ?? ''), [profile.data?.nickname]);
  const handleValid = /^[a-z0-9_]{3,24}$/.test(handle);
  const nicknameBytes = new TextEncoder().encode(nickname).length;
  const nicknameValid =
    nickname.trim().length > 0 && nicknameBytes <= 96 && !/[\u0000-\u001f\u007f]/.test(nickname);
  const available = useQuery({
    queryKey: [manifest.chainId, manifest.userRegistry, 'handle', handle],
    enabled: configured && !registered && handleValid,
    queryFn: () =>
      publicClient.readContract({
        address: manifest.userRegistry!,
        abi: registryAbi,
        functionName: 'resolveHandle',
        args: [handle],
      }),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !nicknameValid ||
      (!registered && (!confirmed || !handleValid || available.data !== zeroAddress))
    )
      return;
    await tx.run(() =>
      registered
        ? tx.send('updateNickname', [nickname])
        : tx.send('registerUser', [handle, nickname]),
    );
  }
  if (profile.isLoading) return <Loading />;
  if (profile.error)
    return <QueryError error={profile.error} retry={() => void profile.refetch()} />;
  return (
    <div className="two-column">
      <section className="panel">
        <h2>{registered ? '我的链上资料' : '注册用户资料'}</h2>
        <p className="muted wrap">
          钱包地址：<code>{account}</code>
        </p>
        {!configured && <Notice>用户资料合约尚未部署，部署后即可注册。</Notice>}
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Handle（永久用户名）</span>
            <input
              value={registered ? profile.data!.handle : handle}
              readOnly={registered}
              onChange={(event) => {
                setHandle(event.target.value);
                setConfirmed(false);
              }}
              placeholder="xiaoming_01"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={24}
              required
            />
          </label>
          <p className="muted">
            3–24 位小写字母、数字或下划线，不包含 @；注册后不可修改、转让或删除。
          </p>
          {!registered && handle && !handleValid && (
            <Notice tone="danger">Handle 格式不正确。</Notice>
          )}
          {!registered && handleValid && available.data && available.data !== zeroAddress && (
            <Notice tone="danger">这个 handle 已被注册，请换一个。</Notice>
          )}
          {!registered && available.error && <QueryError error={available.error} />}
          <label className="field">
            <span>昵称</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="例如：小明"
              required
            />
          </label>
          <p className="muted">支持中文，可重复、可修改；当前 {nicknameBytes}/96 UTF-8 字节。</p>
          {nickname && !nicknameValid && (
            <Notice tone="danger">昵称不能为空白、含控制字符或超过 96 字节。</Notice>
          )}
          {!registered && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我确认 handle 注册后不可修改，并将永久绑定当前钱包。
            </label>
          )}
          <button
            className="primary"
            disabled={
              !configured ||
              chainId !== manifest.chainId ||
              tx.busy ||
              !nicknameValid ||
              (!registered &&
                (!confirmed ||
                  !handleValid ||
                  available.isFetching ||
                  available.data !== zeroAddress)) ||
              (registered && nickname === profile.data?.nickname)
            }
          >
            {tx.busy ? '处理中…' : registered ? '保存昵称到链上' : '确认注册到链上'}
          </button>
        </form>
        <TxStatus tx={tx} />
        {registered && (
          <Link className="secondary" to={continueTo}>
            继续使用业务功能
          </Link>
        )}
      </section>
      <aside className="panel rules">
        <h3>同一个身份，所有商家通用</h3>
        <p>
          你的昵称和 handle
          保存在全局用户注册合约中。注册一次后，可以购买不同商家的会员卡，也可以注册商家。
        </p>
        <h3>昵称用于展示，钱包决定权限</h3>
        <p>
          昵称可以重复。页面同时显示 @handle
          和钱包地址，会员卡及资金权限仍绑定原钱包，修改昵称不会改变。
        </p>
        <p>注册和修改昵称都需要链上交易及测试 MON。填写的昵称和 handle 会公开保存在链上。</p>
      </aside>
    </div>
  );
}

export function ProfilePage() {
  const location = useLocation();
  const from = location.state?.from;
  const continueTo =
    typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
  const { address, chainId } = useAccount();
  return (
    <>
      <Title
        title="用户资料"
        description="设置永久 handle 和可修改的昵称，建立所有商家通用的链上身份。"
      />
      {address ? (
        <ProfileEditor key={`${chainId}:${address}`} account={address} continueTo={continueTo} />
      ) : (
        <Empty title="连接钱包管理用户资料">请使用右上角按钮连接你的钱包。</Empty>
      )}
    </>
  );
}
