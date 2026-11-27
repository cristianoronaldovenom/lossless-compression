// Registered 64-byte line decoder matching memory-page.cjs.
// One accepted request per clock when downstream is ready. Payload little endian.
// No timing closure, ECC, CXL transport or allocation logic is implied.
module s10_memory_line_decode(
 input wire clk,rst,
 input wire in_valid, output wire in_ready,
 input wire [2:0] mode, input wire [6:0] length,
 input wire [511:0] payload,
 output reg out_valid, input wire out_ready,
 output reg [511:0] data, output reg error
);
 reg [511:0] decoded;
 reg invalid;
 reg [519:0] binary_bits;
 reg [9:0] a,b;
 reg [31:0] word32;
 reg [15:0] mask;
 integer i,at;
 assign in_ready=!out_valid||out_ready;
 always @* begin
  decoded=0;invalid=0;binary_bits=0;a=0;b=0;word32=0;mask=0;at=0;
  case(mode)
   0:begin decoded=payload;invalid=(length!=64);end
   1:invalid=(length!=0);
   2:begin invalid=(length!=4);for(i=0;i<16;i=i+1)decoded[i*32+:32]=payload[31:0];end
   3:begin
    invalid=(length!=20||payload[39:32]!=0);
    for(i=0;i<16;i=i+1)begin
     word32={{24{payload[32+i*8+7]}},payload[32+i*8+:8]};
     decoded[i*32+:32]=payload[31:0]+word32;
    end
   end
   4:begin
    a=payload[9:0];b=payload[25:16];
    invalid=(length!=11||payload[15:10]!=0||payload[31:26]!=0||payload[87:84]!=0);
    for(i=0;i<52;i=i+1)binary_bits[i*10+:10]=payload[32+i]?b:a;
    if(binary_bits[519:512]!=0)invalid=1;
    decoded=binary_bits[511:0];
   end
   5:begin
    mask=payload[15:0];at=2;
    for(i=0;i<16;i=i+1)begin
     if(mask[i])begin
      if(at+4>length||at+4>64)invalid=1;
      else begin
       word32=payload[at*8+:32];decoded[i*32+:32]=word32;
       if(word32==0)invalid=1;
      end
      at=at+4;
     end
    end
    if(at!=length)invalid=1;
   end
   default:invalid=1;
  endcase
 end
 always @(posedge clk)begin
  if(rst)begin out_valid<=0;data<=0;error<=0;end
  else if(in_ready)begin
   out_valid<=in_valid;
   if(in_valid)begin data<=invalid?512'b0:decoded;error<=invalid;end
  end
 end
endmodule
