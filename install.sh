#!/usr/bin/env bash
# Instala o Multer no Termux: Node LTS, Bun, as dependências com as versões
# travadas no bun.lock e o comando `multer`.
set -euo pipefail
cd "$(dirname "$0")"

BUN_VERSION=1.4.4

if [ -z "${PREFIX:-}" ] || ! command -v pkg >/dev/null 2>&1; then
  echo "Este instalador é para o Termux. Fora dele: bun install && node bin/multer.js" >&2
  exit 1
fi

bun_works() {
  command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1
}

# O binário oficial do Bun para Android, para quando o pacote do Termux falha.
# O download retoma de onde parou, e o hash é conferido antes de instalar.
install_official_bun() {
  local target work
  case "$(uname -m)" in
    aarch64) target=bun-linux-aarch64-android ;;
    x86_64) target=bun-linux-x64-android ;;
    *) return 1 ;;
  esac
  command -v unzip >/dev/null 2>&1 || pkg install -y unzip || return 1
  work="$HOME/.multer-bun.download"
  mkdir -p "$work"
  local base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  curl -fL --retry 5 --retry-delay 3 --retry-all-errors -C - -o "$work/$target.zip" "$base/$target.zip" || return 1
  curl -fsSL --retry 5 --retry-delay 3 -o "$work/SHASUMS256.txt" "$base/SHASUMS256.txt" || return 1
  if ! (cd "$work" && grep " $target.zip\$" SHASUMS256.txt | sha256sum -c - >/dev/null); then
    rm -rf "$work"
    return 1
  fi
  unzip -qo "$work/$target.zip" -d "$work" || return 1
  install -m 755 "$work/$target/bun" "$PREFIX/bin/bun" || return 1
  rm -rf "$work"
}

ensure_bun() {
  bun_works && return 0
  echo "Instalando o Bun..."
  # Lista de pacotes velha é a causa mais comum de falha no download.
  apt update -y || true
  local attempt
  for attempt in 1 2; do
    pkg install -y bun && bun_works && return 0
    echo "O pacote do Bun falhou (tentativa $attempt de 2)."
    sleep 3
  done
  echo "Tentando o Bun oficial para Android..."
  install_official_bun && bun_works
}

install_dependencies() {
  if ensure_bun; then
    # O Bun não roda scripts de instalação de pacotes: nada do pacote executa aqui.
    bun install --frozen-lockfile --production && return 0
    echo "O bun install falhou."
  else
    echo "Não consegui instalar o Bun."
  fi
  echo "Seguindo com o npm, que vem com o Node."
  rm -rf node_modules
  npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
}

# nodejs-lts e nodejs são excludentes; se já há um Node que atende ao REA, fica ele.
command -v node >/dev/null 2>&1 || pkg install -y nodejs-lts
# Node antigo não roda TypeScript direto: o Multer nem abriria.
node -e "process.exit(process.features.typescript ? 0 : 1)" || pkg install -y nodejs-lts
# Abre o navegador no /login chave.
command -v termux-open-url >/dev/null 2>&1 || pkg install -y termux-tools

install_dependencies

# Build minificado: o app publicado não vai em TypeScript legível. Se o Bun não veio,
# o lançador cai no fonte e tudo continua funcionando.
command -v bun >/dev/null 2>&1 && bun run build >/dev/null 2>&1 || echo "Sem build minificado: seguindo no fonte."

# Lançador próprio: /usr/bin/env só existe no Termux quando o termux-exec está ativo.
rm -f "$PREFIX/bin/multer"
cat > "$PREFIX/bin/multer" <<LAUNCHER
#!$PREFIX/bin/sh
exec "$PREFIX/bin/node" "$PWD/bin/multer.js" "\$@"
LAUNCHER
chmod +x "$PREFIX/bin/multer"

node bin/multer.js --doutor
echo
echo "Pronto. Entre na pasta do seu projeto e rode: multer"
