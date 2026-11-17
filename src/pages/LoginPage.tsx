import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Delete, KeyRound, ShieldAlert, Trophy, CheckCircle2, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const LoginPage: React.FC = () => {
  const { loginByPin } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleDigit = (digit: string) => {
    setError(null);
    if (pin.length < 8) {
      setPin((prev) => prev + digit);
    }
  };

  const handleBackspace = () => {
    setError(null);
    setPin((prev) => prev.slice(0, -1));
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username.trim()) {
      setError('Ingresá tu nombre de usuario.');
      return;
    }
    if (pin.length < 4) {
      setError('Ingresá al menos 4 dígitos de tu PIN o contraseña.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const profile = await loginByPin(pin, username.trim());
      if (profile.role === 'admin') {
        navigate('/admin');
      } else {
        navigate('/crono');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al validar credenciales');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-56px)] flex flex-col justify-between p-4 max-w-md mx-auto">
      <div className="space-y-4">
        <div className="text-center pt-2">
          <div className="inline-flex items-center justify-center mb-2">
            <img
              src="/skol-logo.jpg"
              alt="SKOL Classic"
              className="w-28 h-28 rounded-2xl object-cover border-2 border-amber-400/60 shadow-lg shadow-amber-500/15"
            />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-amber-400 uppercase">
            SKOL CLASSIC
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Ingresá tu nombre de usuario y tu código PIN / contraseña
          </p>
        </div>

        {/* Formulario de Usuario + PIN */}
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Campo Nombre de Usuario */}
          <div className="bg-slate-900 border-2 border-slate-700 focus-within:border-amber-400 rounded-2xl px-4 py-3 flex items-center gap-3 transition">
            <User className="w-5 h-5 text-amber-400 shrink-0" />
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setError(null);
                setUsername(e.target.value);
              }}
              placeholder="Nombre de usuario (ej. Admin)"
              className="w-full bg-transparent text-base font-bold text-white placeholder:text-slate-500 focus:outline-none"
              aria-label="Nombre de usuario"
            />
          </div>

          {/* Visor del PIN / Contraseña */}
          <div className="bg-slate-900 border-2 border-slate-700 focus-within:border-amber-400 rounded-2xl px-4 py-3 flex items-center justify-between transition">
            <KeyRound className="w-5 h-5 text-amber-400 shrink-0" />
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => {
                setError(null);
                setPin(e.target.value.replace(/\D/g, '').slice(0, 8));
              }}
              placeholder="PIN / Contraseña"
              className="w-full bg-transparent text-center text-2xl font-black tracking-[0.25em] text-white placeholder:text-sm placeholder:tracking-normal placeholder:font-semibold placeholder:text-slate-500 focus:outline-none"
              aria-label="Código PIN"
            />
            <span className="text-xs font-mono text-slate-400 shrink-0">
              {pin.length}/8
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-950/90 border border-rose-700 text-rose-200 text-xs font-semibold">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Teclado numérico enorme para uso con una mano */}
          <div className="grid grid-cols-3 gap-2.5 select-none">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => handleDigit(digit)}
                className="h-14 rounded-2xl bg-slate-900 hover:bg-slate-800 active:bg-amber-400 active:text-slate-950 border border-slate-700 text-2xl font-black transition active:scale-95"
              >
                {digit}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setPin('')}
              className="h-14 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-bold uppercase text-slate-400"
            >
              Limpiar
            </button>

            <button
              type="button"
              onClick={() => handleDigit('0')}
              className="h-14 rounded-2xl bg-slate-900 hover:bg-slate-800 active:bg-amber-400 active:text-slate-950 border border-slate-700 text-2xl font-black transition active:scale-95"
            >
              0
            </button>

            <button
              type="button"
              onClick={handleBackspace}
              className="h-14 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-300"
              aria-label="Borrar dígito"
            >
              <Delete className="w-6 h-6" />
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting || !username.trim() || pin.length < 4}
            className="w-full h-14 rounded-2xl bg-amber-400 hover:bg-amber-500 disabled:opacity-40 text-slate-950 font-black text-lg tracking-wide uppercase transition flex items-center justify-center gap-2 shadow-lg shadow-amber-400/20"
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>{submitting ? 'Verificando...' : 'Ingresar'}</span>
          </button>
        </form>
      </div>

      <div className="pt-4 pb-2 text-center">
        <Link
          to="/resultados"
          className="inline-flex items-center gap-2 text-xs font-bold text-amber-400 hover:text-amber-300 underline underline-offset-4"
        >
          <Trophy className="w-4 h-4" />
          <span>Ir a la Vista Pública de Resultados en Vivo (sin login)</span>
        </Link>
      </div>
    </div>
  );
};
