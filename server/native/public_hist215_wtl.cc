// Finite public-only runtime feasibility prototype. No model/labels/transport.
#include <node_api.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
using I=std::int64_t;
using Score=std::uint32_t;
using Mass=__int128;
void require(bool v,const char* m){if(!v)throw std::runtime_error(m);}
int straight(unsigned mask){for(int hi=14;hi>=6;--hi)if((mask&(31u<<(hi-4)))==(31u<<(hi-4)))return hi;return (mask&0x403cu)==0x403cu?5:0;}
Score packed(int cat,const std::vector<int>& values){Score s=cat;for(int i=0;i<5;++i)s=s*15+(i<int(values.size())?values[i]:0);return s;}
Score evaluate(const std::vector<int>& cards){
    int counts[15]={},suitcounts[4]={};unsigned mask=0,suitmasks[4]={};
    for(int c:cards){int r=c/4+2,s=c%4;++counts[r];++suitcounts[s];mask|=1u<<r;suitmasks[s]|=1u<<r;}
    int fs=-1;for(int s=0;s<4;++s)if(suitcounts[s]>=5){int st=straight(suitmasks[s]);if(st)return packed(8,{st});fs=s;}
    std::vector<int> ranks,pairs,trips;int quad=0;
    for(int r=14;r>=2;--r){if(counts[r])ranks.push_back(r);if(counts[r]>=2)pairs.push_back(r);if(counts[r]>=3)trips.push_back(r);if(counts[r]==4)quad=r;}
    if(quad){for(int r:ranks)if(r!=quad)return packed(7,{quad,r});}
    if(!trips.empty())for(int r:pairs)if(r!=trips[0])return packed(6,{trips[0],r});
    if(fs>=0){std::vector<int> f;for(int r=14;r>=2;--r)if(suitmasks[fs]&(1u<<r))f.push_back(r);return packed(5,f);}
    if(int st=straight(mask))return packed(4,{st});
    if(!trips.empty()){std::vector<int> v{trips[0]};for(int r:ranks)if(r!=trips[0])v.push_back(r);v.resize(3);return packed(3,v);}
    if(pairs.size()>=2){for(int r:ranks)if(r!=pairs[0]&&r!=pairs[1])return packed(2,{pairs[0],pairs[1],r});}
    if(pairs.size()==1){std::vector<int> v{pairs[0]};for(int r:ranks)if(r!=pairs[0])v.push_back(r);v.resize(4);return packed(1,v);}
    return packed(0,ranks);
}

static void ok(napi_status s){require(s==napi_ok,"NAPI boundary failure");}
static std::vector<int> cards(napi_env env,napi_value value,unsigned lo,unsigned hi){
    bool array=false;ok(napi_is_array(env,value,&array));require(array,"cards must be Array");
    uint32_t n=0;ok(napi_get_array_length(env,value,&n));require(n>=lo&&n<=hi,"card count differs");std::vector<int> out;
    for(uint32_t i=0;i<n;++i){napi_value v;napi_valuetype type;ok(napi_get_element(env,value,i,&v));ok(napi_typeof(env,v,&type));require(type==napi_number,"card must be number");double d;ok(napi_get_value_double(env,v,&d));require(std::isfinite(d)&&d>=0&&d<52&&std::floor(d)==d,"invalid52-card ID");out.push_back(static_cast<int>(d));}
    return out;
}
static std::array<I,1326> weights(napi_env env,napi_value value){
    bool array=false;ok(napi_is_array(env,value,&array));require(array,"weights must be BigInt Array");uint32_t n=0;ok(napi_get_array_length(env,value,&n));require(n==1326,"exact1326 weights required");std::array<I,1326> out{};Mass sum=0;
    for(uint32_t i=0;i<n;++i){napi_value v;napi_valuetype type;ok(napi_get_element(env,value,i,&v));ok(napi_typeof(env,v,&type));require(type==napi_bigint,"weight must be BigInt");bool lossless=false;int64_t w;ok(napi_get_value_bigint_int64(env,v,&w,&lossless));require(lossless&&w>=0,"nonnegativeint64 weight required");out[i]=w;sum+=w;require(sum<=std::numeric_limits<I>::max(),"root weight sum overflows int64");}
    require(sum>0,"positive root range mass required");return out;
}
static std::string decimal(Mass n){require(n>=0,"negative mass");if(n==0)return "0";std::string s;while(n){s.push_back(static_cast<char>('0'+n%10));n/=10;}std::reverse(s.begin(),s.end());return s;}
static napi_value mass_array(napi_env env,Mass w,Mass t,Mass z){
    require(w>=0&&t>=0&&z>=w+t,"invalid exact WTL mass");napi_value a;ok(napi_create_array_with_length(env,4,&a));Mass values[4]={w,t,z-w-t,z};
    for(unsigned i=0;i<4;++i){auto s=decimal(values[i]);napi_value v;ok(napi_create_string_utf8(env,s.data(),s.size(),&v));ok(napi_set_element(env,a,i,v));}return a;
}
static napi_value exact_root_wtl(napi_env env,napi_callback_info info){try{
    size_t argc=4;napi_value args[4];ok(napi_get_cb_info(env,info,&argc,args,nullptr,nullptr));require(argc==3,"exactRootWTL expects own, board, normalizedweights");
    auto own=cards(env,args[0],2,2),board=cards(env,args[1],3,5);auto weight=weights(env,args[2]);std::array<bool,52> blocked{};
    for(int c:own){require(!blocked[c],"duplicate card");blocked[c]=true;}for(int c:board){require(!blocked[c],"duplicate card");blocked[c]=true;}
    struct Opp{int a,b;I w;};std::vector<Opp> opp;Mass z0=0;unsigned index=0;
    for(int b=1;b<52;++b)for(int a=0;a<b;++a){I w=weight[index++];if(w&&!blocked[a]&&!blocked[b]){opp.push_back({a,b,w});z0+=w;}}
    require(z0>0,"zero own-compatible root range mass");std::vector<int> hero=board;hero.insert(hero.end(),own.begin(),own.end());Score hs=evaluate(hero);Mass cw=0,ct=0;
    for(const auto&o:opp){auto hand=board;hand.push_back(o.a);hand.push_back(o.b);Score s=evaluate(hand);if(hs>s)cw+=o.w;else if(hs==s)ct+=o.w;}
    Mass tw=0,tt=0,tz=0;int runs=0;
    auto process=[&](const std::vector<int>& finalboard,int added1,int added2){
        ++runs;auto h=finalboard;h.insert(h.end(),own.begin(),own.end());Score score=evaluate(h);auto other=finalboard;other.resize(7);
        for(const auto&o:opp){if(o.a==added1||o.a==added2||o.b==added1||o.b==added2)continue;other[5]=o.a;other[6]=o.b;Score s=evaluate(other);tz+=o.w;if(score>s)tw+=o.w;else if(score==s)tt+=o.w;}
    };
    if(board.size()==5)process(board,-1,-1);
    else for(int a=0;a<52;++a)if(!blocked[a]){auto f=board;f.push_back(a);if(board.size()==4)process(f,a,-1);else for(int b=a+1;b<52;++b)if(!blocked[b]){auto g=f;g.push_back(b);process(g,a,b);}}
    int expected=board.size()==3?1081:board.size()==4?46:1;int factor=board.size()==3?990:board.size()==4?44:1;
    require(runs==expected&&tz==z0*factor,"exact joint denominator/runout identity failed");
    napi_value result;ok(napi_create_object(env,&result));ok(napi_set_named_property(env,result,"current",mass_array(env,cw,ct,z0)));ok(napi_set_named_property(env,result,"terminal",mass_array(env,tw,tt,tz)));
    napi_value count;ok(napi_create_int32(env,runs,&count));ok(napi_set_named_property(env,result,"terminalRunouts",count));ok(napi_create_uint32(env,static_cast<uint32_t>(opp.size()),&count));ok(napi_set_named_property(env,result,"opponentCompatibleCombos",count));return result;
}catch(const std::exception&e){napi_throw_error(env,"EXACT_ROOT_WTL_REFUSED",e.what());return nullptr;}}
static napi_value init(napi_env env,napi_value exports){napi_value fn;if(napi_create_function(env,"exactRootWTL",NAPI_AUTO_LENGTH,exact_root_wtl,nullptr,&fn)!=napi_ok)return nullptr;if(napi_set_named_property(env,exports,"exactRootWTL",fn)!=napi_ok)return nullptr;return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
