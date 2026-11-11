#!/bin/sh
# Sync spike: can the unchanged Syncthing release keep one folder the same on two
# computers with every public service off, given only device IDs and addresses?
#   case A  both peers on one network, each handed the other's address
#   case B  each peer behind its own NAT router, each handed the other router's address
# Usage: [PODMAN_CONNECTION=name] [SPIKE_CACHE=dir] sh spike/syncthing/run.sh
# The last three lines are "case A: PASS|FAIL <reason>", "case B: ..." and "outcome: ...".
# Exit 0: both cases reached a verdict. Non-zero: a harness fault ("FAULT ..." line).
set -u

VER=v2.1.7
WAIT=120 # pass window: seconds from both peers running with the folder shared
CANARY='CONNECT tandem-canary.invalid:443'
here=$(cd "$(dirname "$0")" && pwd) || exit 1
tmp=$(mktemp -d) || exit 1

pm() {
  if [ -n "${PODMAN_CONNECTION:-}" ]; then podman --connection "$PODMAN_CONNECTION" "$@"; else podman "$@"; fi
}
die() { echo "FAULT $*"; exit 1; }
cleanup() {
  for c in $(pm ps -a --format '{{.Names}}' 2>/dev/null | grep '^tandem-st-'); do pm rm -f -t 0 "$c" >/dev/null 2>&1; done
  for n in $(pm network ls --format '{{.Name}}' 2>/dev/null | grep '^tandem-st-'); do pm network rm -f "$n" >/dev/null 2>&1; done
}
trap 'cleanup; rm -rf "$tmp"' EXIT
trap 'exit 130' HUP INT TERM
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
rnd() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# Logging proxy: one line per request (method and target), forwards nothing.
PROXY_JS='const fs=require("fs"),http=require("http");
const log=l=>fs.appendFileSync("/tmp/proxy.log",l+"\n");
const s=http.createServer((q,r)=>{log(q.method+" "+q.url);r.writeHead(403);r.end()});
s.on("connect",(q,c)=>{log("CONNECT "+q.url);c.end("HTTP/1.1 403 Forbidden\r\n\r\n")});
s.on("clientError",(e,c)=>{log("NOT-HTTP "+e.code);c.destroy()});
s.listen(3128,()=>fs.writeFileSync("/tmp/ready",""));'

# REST probe run inside a Syncthing container (plain http module: no proxy env).
# poll|conn KEY PEER: "<up|down> <type> <address> udp=<socket rows>"
# readback KEY PEER PEER_ADDRESS: one line per setting; exit 3 on a mismatch
PROBE_JS='const [m,k,peer,addr]=process.argv.slice(1),fs=require("fs"),http=require("http");
const get=p=>new Promise((ok,no)=>http.get({host:"127.0.0.1",port:8384,path:p,headers:{"X-API-Key":k}},r=>{let b="";
  r.on("data",d=>b+=d);r.on("end",()=>r.statusCode==200?ok(JSON.parse(b)):no(Error(p+" HTTP "+r.statusCode)))}).on("error",no));
const udp=()=>["/proc/net/udp","/proc/net/udp6"].reduce((n,f)=>n+fs.readFileSync(f,"utf8").trim().split("\n").length-1,0);
(async()=>{
  if(m=="poll"||m=="conn"){const c=(await get("/rest/system/connections")).connections[peer]||{};
    console.log((c.connected?"up":"down")+" "+(c.type||"-")+" "+(c.address||"-")+" udp="+udp());return}
  const o=await get("/rest/config/options"),d=await get("/rest/config/devices/"+peer),g=await get("/rest/config/gui"),f=await get("/rest/config/folders/skills");
  const rows=[["options.globalAnnounceEnabled",o.globalAnnounceEnabled,false],["options.localAnnounceEnabled",o.localAnnounceEnabled,false],
    ["options.relaysEnabled",o.relaysEnabled,false],["options.natEnabled",o.natEnabled,false],["options.stunKeepaliveStartS",o.stunKeepaliveStartS,0],
    ["options.urAccepted",o.urAccepted,-1],["options.crashReportingEnabled",o.crashReportingEnabled,false],["options.autoUpgradeIntervalH",o.autoUpgradeIntervalH,0],
    ["options.listenAddresses",o.listenAddresses,["tcp://0.0.0.0:22000"]],["peer.addresses",d.addresses,[addr]],["peer.introducer",d.introducer,false],
    ["peer.autoAcceptFolders",d.autoAcceptFolders,false],["gui.address",g.address,"127.0.0.1:8384"],
    ["folder skills shared with peer",f.devices.some(x=>x.deviceID==peer),true]];
  let bad=0;for(const [n,v,w] of rows){const ok=JSON.stringify(v)==JSON.stringify(w);bad+=!ok;console.log(n+" = "+JSON.stringify(v)+(ok?" ok":" MISMATCH, want "+JSON.stringify(w)))}
  process.exit(bad?3:0)})().catch(e=>{console.log("probe error: "+e.message);process.exit(2)});'

# --- the release, unchanged, checked before every use -------------------------
arch=$(pm info --format '{{.Host.Arch}}') || die "podman info failed"
case $arch in
  arm64) want=48e456690cd2b97e7d26b02b5ac35f62a3b36172267b144cfeaf02c993ab955c ;;
  amd64) want=2edc416e7ed136b7c858ed5f3f02a3b8316589605e54c380228ceea7acbf0142 ;;
  *) die "unsupported arch $arch" ;;
esac
cache=${SPIKE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/tandem-spike}
rel=syncthing-linux-$arch-$VER
tgz=$cache/$rel.tar.gz
state=cached
if [ ! -f "$tgz" ]; then
  mkdir -p "$cache" || die "cannot make $cache"
  curl -fsSL -o "$tgz.part" "https://github.com/syncthing/syncthing/releases/download/$VER/$rel.tar.gz" || die "download failed"
  mv "$tgz.part" "$tgz" || die "cannot store $tgz"
  state=downloaded
fi
got=$(sha "$tgz")
[ "$got" = "$want" ] || die "checksum mismatch for $rel.tar.gz: pinned $want, got $got"
echo "release: $state, checksum ok"
tar -xzf "$tgz" -C "$tmp" "$rel/syncthing" || die "cannot unpack $rel"
bin=$tmp/$rel/syncthing

# --- image: tandem-test plus iptables and iproute2 -----------------------------
cleanup
pm image exists tandem-test || die "image tandem-test missing (build it from test/env/Containerfile)"
mkdir "$tmp/ctx" || die "mkdir failed"
img=$(printf '%s\n' 'FROM localhost/tandem-test' \
  'RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 && rm -rf /var/lib/apt/lists/*' |
  pm build -q -t tandem-st-img -f - "$tmp/ctx") || die "image tandem-st-img build failed"
echo "image: tandem-st-img $img"

# --- helpers --------------------------------------------------------------------
box() { # name [podman run options]: a container that idles until used
  n=$1; shift
  pm run -d --name "$n" "$@" tandem-st-img sleep infinity >/dev/null || die "container $n did not start"
}
ip_on() { pm inspect --format "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }
subnet() { pm network inspect --format '{{range .Subnets}}{{.Subnet}}{{end}}' "$1"; }
net() { pm network create --internal "$1" >/dev/null || die "network $1 not created"; }
proxy() { # name network: start the logging proxy, set PX to its URL
  box "$1" --network "$2"
  pm exec -d "$1" node -e "$PROXY_JS" >/dev/null || die "proxy $1 did not start"
  i=0; until pm exec "$1" test -f /tmp/ready; do i=$((i + 1)); [ $i -lt 20 ] || die "proxy $1 not listening"; sleep 0.5; done
  PX="http://$(ip_on "$1" "$2"):3128"
}
peer_box() { # name network proxy_url [podman run options]: a Syncthing side, keys generated
  n=$1; nw=$2; px=$3; shift 3
  box "$n" --network "$nw" -e STNOUPGRADE=1 -e HTTP_PROXY="$px" -e HTTPS_PROXY="$px" "$@"
  pm cp "$bin" "$n:/usr/local/bin/syncthing" || die "podman cp into $n failed"
  pm exec "$n" sh -c 'mkdir -p /st/skills/.stfolder && syncthing generate --home=/st/home >/st/generate.log 2>&1' ||
    die "syncthing generate failed in $n"
}
configure() { # name self_id peer_id peer_address api_key
  v=$(pm exec "$1" sed -n 's/.*<configuration version="\([0-9]*\)".*/\1/p' /st/home/config.xml)
  [ -n "$v" ] || die "no config version from $1"
  sed -e "s|@VERSION@|$v|" -e "s|@SELF_ID@|$2|g" -e "s|@PEER_ID@|$3|g" -e "s|@PEER_ADDRESS@|$4|" -e "s|@API_KEY@|$5|" \
    "$here/config.xml" > "$tmp/$1.xml" || die "cannot fill config for $1"
  pm cp "$tmp/$1.xml" "$1:/st/home/config.xml" || die "podman cp config into $1 failed"
}
manifest() { # sha256 of every file and the target of every symlink, .stfolder left out
  pm exec "$1" sh -c 'cd /st/skills && { find . -path ./.stfolder -prune -o -type f -print0 | xargs -0 -r sha256sum | sort -k2;
    find . -path ./.stfolder -prune -o -type l -printf "symlink %p -> %l\n"; }'
}

# --- one case: the same test on any layout ------------------------------------------
# run_case L side1 side2 proxy_container address_side1_dials address_side2_dials
run_case() {
  L=$1; s1=$2; s2=$3; px=$4; h1=$5; a1=tcp://$5:22000; a2=tcp://$6:22000
  k1=$(rnd); k2=$(rnd)
  id1=$(pm exec "$s1" syncthing device-id --home=/st/home) || die "[$L] no device ID from $s1"
  id2=$(pm exec "$s2" syncthing device-id --home=/st/home) || die "[$L] no device ID from $s2"
  configure "$s1" "$id1" "$id2" "$a1" "$k1"
  configure "$s2" "$id2" "$id1" "$a2" "$k2"
  echo "[$L] side 1 $id1 is handed peer $id2 at $a1"
  echo "[$L] side 2 $id2 is handed peer $id1 at $a2"
  pm exec "$s1" sh -c 'cd /st/skills && mkdir demo && printf "# demo\nA test skill.\n" > demo/SKILL.md &&
    i=1 && while [ $i -le 99 ]; do head -c 4096 /dev/urandom > demo/f$i.bin; i=$((i + 1)); done && ln -s demo link' ||
    die "[$L] cannot make content on side 1"
  m1=$(manifest "$s1")
  echo "[$L] side 1 content: $(printf '%s\n' "$m1" | grep -c '^[0-9a-f]\{64\} ') files, $(printf '%s\n' "$m1" | grep '^symlink')"

  # Canary: one CONNECT through HTTPS_PROXY from a Syncthing container, before Syncthing runs.
  pm exec "$s1" curl -sS -m 5 -o /dev/null https://tandem-canary.invalid/ >/dev/null 2>&1
  pm exec "$px" cat /tmp/proxy.log 2>/dev/null | grep -qxF "$CANARY" || die "[$L] canary missing from the proxy log"
  echo "[$L] canary in proxy log: $CANARY"

  for s in "$s1" "$s2"; do
    pm exec -d "$s" sh -c 'exec syncthing serve --home=/st/home --no-browser --no-restart >/st/syncthing.log 2>&1' >/dev/null ||
      die "[$L] syncthing did not start in $s"
  done
  i=0
  until pm exec "$s1" curl --noproxy '*' -fsS -m 2 -H "X-API-Key: $k1" http://127.0.0.1:8384/rest/system/ping >/dev/null 2>&1 &&
    pm exec "$s2" curl --noproxy '*' -fsS -m 2 -H "X-API-Key: $k2" http://127.0.0.1:8384/rest/system/ping >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -lt 60 ] || die "[$L] syncthing API did not answer: $(pm exec "$s1" tail -n 5 /st/syncthing.log)"; sleep 0.5
  done
  t0=$(date +%s)
  echo "[$L] t0: both Syncthing processes run with folder skills shared"

  conn_s= ctype=- caddr=- sync_s= udp_max=0 polls=0
  while :; do
    p1=$(pm exec "$s1" node -e "$PROBE_JS" poll "$k1" "$id2") || die "[$L] probe failed on side 1: $p1"
    p2=$(pm exec "$s2" node -e "$PROBE_JS" poll "$k2" "$id1") || die "[$L] probe failed on side 2: $p2"
    el=$(($(date +%s) - t0)); polls=$((polls + 1))
    [ $el -le $WAIT ] || break
    for p in "$p1" "$p2"; do u=${p##*udp=}; [ "$u" -le "$udp_max" ] || udp_max=$u; done
    set -- $p1
    if [ -z "$conn_s" ] && [ "$1" = up ]; then conn_s=$el ctype=$2 caddr=$3; echo "[$L] connected after $el s: side 1 sees $2 $3"; fi
    if [ -n "$conn_s" ]; then
      m1=$(manifest "$s1"); m2=$(manifest "$s2")
      el=$(($(date +%s) - t0))
      if [ "$m1" = "$m2" ] && [ $el -le $WAIT ]; then sync_s=$el; echo "[$L] folders equal after $el s"; break; fi
    fi
    sleep 1
  done
  [ -n "$conn_s" ] || echo "[$L] never connected in $WAIT s ($polls polls)"
  for s in "$s1" "$s2"; do
    [ "$s" = "$s1" ] && { k=$k1; peer=$id2; a=$a1; } || { k=$k2; peer=$id1; a=$a2; }
    echo "[$L] $s connection to peer now: $(pm exec "$s" node -e "$PROBE_JS" conn "$k" "$peer")"
    rb=$(pm exec "$s" node -e "$PROBE_JS" readback "$k" "$peer" "$a"); rc=$?
    printf '%s\n' "$rb" | sed "s/^/[$L] $s read back: /"
    [ $rc -ne 2 ] || die "[$L] read-back failed on $s"
    [ $rc -eq 0 ] || echo "mismatch $s" >> "$tmp/bad.$L"
    env=$(pm exec "$s" sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = syncthing ] || continue;
      printf "pid %s: " "${p#/proc/}"; tr "\0" "\n" < $p/environ | grep -iE "^(STNOUPGRADE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)=" | tr "\n" " "; echo; done')
    printf '%s\n' "$env" | sed "s/^/[$L] $s environ: /"
    printf '%s\n' "$env" | grep -q 'STNOUPGRADE=1' || die "[$L] STNOUPGRADE=1 not in the syncthing environ on $s"
    ! printf '%s\n' "$env" | grep -qi 'all_proxy=' || die "[$L] all_proxy set on $s"
    pm exec "$s" sh -c 'for f in /proc/net/udp /proc/net/udp6; do echo "$f: $(($(wc -l < $f) - 1)) rows after the header"; cat $f; done' |
      sed "s/^/[$L] $s udp: /"
  done
  echo "[$L] udp rows seen in $polls polls of both sides: max $udp_max"
  plog=$(pm exec "$px" cat /tmp/proxy.log)
  printf '%s\n' "$plog" | sed "s/^/[$L] proxy log: /"
  extra=$(printf '%s\n' "$plog" | grep -cvxF "$CANARY")
  if [ -n "$conn_s" ]; then
    m2=$(manifest "$s2")
    echo "[$L] side 2 now holds: $(printf '%s\n' "$m2" | grep -c '^[0-9a-f]\{64\} ') files, $(printf '%s\n' "$m2" | grep '^symlink' || echo 'no symlink')"
  else
    echo "[$L] side 1 plain TCP connect to $a1: $(pm exec "$s1" node -e 'const s=require("net").connect(22000,process.argv[1]);
      s.setTimeout(5000,()=>{console.log("timeout");process.exit()});s.on("connect",()=>{console.log("open");s.destroy()}).on("error",e=>console.log(e.code))' "$h1")"
  fi

  case $ctype in
    -) v="FAIL never connected within $WAIT s" ;;
    tcp-*) if [ -n "$sync_s" ]; then v="PASS connected directly ($ctype $caddr) in $conn_s s; 100 files and the symlink equal in $sync_s s"
           else v="FAIL connected ($ctype $caddr) in $conn_s s, folders not equal within $WAIT s"; fi ;;
    *) v="FAIL connected over $ctype, not direct TCP" ;;
  esac
  tail_why="proxy: canary only; udp: no rows"
  [ "$extra" -eq 0 ] || { v="FAIL ${v#* }"; tail_why="proxy: $extra lines besides the canary"; }
  [ "$udp_max" -eq 0 ] || { v="FAIL ${v#* }"; tail_why="$tail_why; udp: $udp_max rows"; }
  [ ! -f "$tmp/bad.$L" ] || { v="FAIL ${v#* }"; tail_why="$tail_why; a setting read back wrong"; }
  echo "$v; $tail_why" > "$tmp/verdict.$L"
}

# --- case A: one internal network -------------------------------------------------
net tandem-st-a-net
proxy tandem-st-a-proxy tandem-st-a-net
peer_box tandem-st-a-1 tandem-st-a-net "$PX"
peer_box tandem-st-a-2 tandem-st-a-net "$PX"
echo "[A] layout: one --internal network holding both sides and the proxy $PX"
run_case A tandem-st-a-1 tandem-st-a-2 tandem-st-a-proxy \
  "$(ip_on tandem-st-a-2 tandem-st-a-net)" "$(ip_on tandem-st-a-1 tandem-st-a-net)"
cleanup

# --- case B: each side behind its own NAT router, no port forward --------------------
net tandem-st-b-lan1; net tandem-st-b-lan2; net tandem-st-b-wan
for i in 1 2; do
  box tandem-st-b-r$i --network tandem-st-b-lan$i --network tandem-st-b-wan --cap-add NET_ADMIN --sysctl net.ipv4.ip_forward=1
  sn=$(subnet tandem-st-b-lan$i)
  pm exec tandem-st-b-r$i iptables -t nat -A POSTROUTING -s "$sn" ! -d "$sn" -j MASQUERADE || die "[B] masquerade on router $i failed"
done
proxy tandem-st-b-proxy tandem-st-b-wan
for i in 1 2; do
  peer_box tandem-st-b-$i tandem-st-b-lan$i "$PX" --cap-add NET_ADMIN
  pm exec tandem-st-b-$i ip route replace default via "$(ip_on tandem-st-b-r$i tandem-st-b-lan$i)" || die "[B] default route on side $i failed"
done
r1=$(ip_on tandem-st-b-r1 tandem-st-b-wan); r2=$(ip_on tandem-st-b-r2 tandem-st-b-wan)
echo "[B] layout: side 1 on lan1 behind router $r1, side 2 on lan2 behind router $r2, proxy $PX on wan; all --internal"
for i in 1 2; do
  echo "[B] router $i nat: $(pm exec tandem-st-b-r$i iptables -t nat -S POSTROUTING | grep MASQUERADE)"
  echo "[B] side $i routes: $(pm exec tandem-st-b-$i ip route | tr '\n' ';')"
done
run_case B tandem-st-b-1 tandem-st-b-2 tandem-st-b-proxy "$r2" "$r1"
cleanup

left=$( { pm ps -a --format '{{.Names}}'; pm network ls --format '{{.Name}}'; } | grep '^tandem-st-')
[ -z "$left" ] || die "left behind: $left"
va=$(cut -d' ' -f1 "$tmp/verdict.A"); vb=$(cut -d' ' -f1 "$tmp/verdict.B")
case "$va $vb" in
  "PASS PASS") out='direct only, U-R1B-82 skipped' ;;
  "PASS FAIL") out='direct where reachable, hub link elsewhere (U-R1B-82)' ;;
  *) out="case A failed; U-R1B-79 to U-R1B-84 wait for the director's plan amendment" ;;
esac
echo "case A: $(cat "$tmp/verdict.A")"
echo "case B: $(cat "$tmp/verdict.B")"
echo "outcome: $out"
